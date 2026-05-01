require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getAutomationSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['pending_to_sold_days', 'sold_to_archived_days']);

  if (error) {
    console.error('Failed to fetch settings:', error.message);
    return null;
  }

  const settings = {};
  (data || []).forEach(row => {
    settings[row.key] = row.value ? parseInt(row.value) : null;
  });

  return settings;
}

async function processAutoTransitions() {
  console.log(`[${new Date().toISOString()}] Running auto-transition check...`);

  const settings = await getAutomationSettings();
  if (!settings) return;

  const { pending_to_sold_days, sold_to_archived_days } = settings;

  if (!pending_to_sold_days && !sold_to_archived_days) {
    console.log('No auto-transition rules configured. Skipping.');
    return;
  }

  const now = new Date();
  let transitioned = 0;

  // Pending → Sold
  if (pending_to_sold_days) {
    const cutoff = new Date(now.getTime() - pending_to_sold_days * 24 * 60 * 60 * 1000);

    const { data: pendingProperties, error } = await supabase
      .from('properties')
      .select('id, address')
      .eq('property_status', 'pending')
      .eq('status', 'active')
      .not('property_status_changed_at', 'is', null)
      .lte('property_status_changed_at', cutoff.toISOString());

    if (error) {
      console.error('Failed to fetch pending properties:', error.message);
    } else if (pendingProperties && pendingProperties.length > 0) {
      for (const property of pendingProperties) {
        const { error: updateErr } = await supabase
          .from('properties')
          .update({
            property_status: 'sold',
            property_status_changed_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('id', property.id);

        if (updateErr) {
          console.error(`Failed to transition property ${property.id}:`, updateErr.message);
        } else {
          console.log(`✓ ${property.address} → sold (after ${pending_to_sold_days} days)`);
          transitioned++;
        }
      }
    }
  }

  // Sold → Archived
  if (sold_to_archived_days) {
    const cutoff = new Date(now.getTime() - sold_to_archived_days * 24 * 60 * 60 * 1000);

    const { data: soldProperties, error } = await supabase
      .from('properties')
      .select('id, address')
      .eq('property_status', 'sold')
      .eq('status', 'active')
      .not('property_status_changed_at', 'is', null)
      .lte('property_status_changed_at', cutoff.toISOString());

    if (error) {
      console.error('Failed to fetch sold properties:', error.message);
    } else if (soldProperties && soldProperties.length > 0) {
      for (const property of soldProperties) {
        const { error: updateErr } = await supabase
          .from('properties')
          .update({
            property_status: 'archived',
            property_status_changed_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('id', property.id);

        if (updateErr) {
          console.error(`Failed to transition property ${property.id}:`, updateErr.message);
        } else {
          console.log(`✓ ${property.address} → archived (after ${sold_to_archived_days} days)`);
          transitioned++;
        }
      }
    }
  }

  if (transitioned === 0) {
    console.log('No properties due for transition.');
  } else {
    console.log(`Transitioned ${transitioned} property(ies).`);
  }
}

// ─── Kaizen FSBO Lead Fetcher ────────────────────────────────────────────────

function normalizeLead(raw) {
  return {
    lead_id:          raw.lead_id || null,
    lead_type:        raw.lead_type || 'FSBO',
    address:          raw['exact street address'] || raw.address || '',
    price:            raw['asking price'] ?? raw.price ?? null,
    seller_name:      raw['seller name'] || raw['seller name / company'] || '',
    phone:            raw['phone number'] || raw['seller contact number'] || '',
    images:           raw['hosted property photos'] || raw.lead_images || [],
    beds:             raw.beds ?? null,
    baths:            raw.baths ?? null,
    state:            raw.state || '',
    facebook_post_url: raw.facebook_post_url || null,
  };
}

async function fetchKaizenPage(cursor) {
  const url = cursor
    ? `https://api.kaizendata.co/enterprise/leads/query?cursor=${cursor}`
    : `https://api.kaizendata.co/enterprise/leads/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KAIZEN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      lead_types: ['FSBO'],
      states: 'all',
      fields: [
        'lead_id', 'lead_type',
        'seller name', 'phone number', 'exact street address', 'asking price',
        'facebook_post_url', 'hosted property photos', 'lead_images',
        'beds', 'baths', 'state',
      ],
      limit: 100,
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) throw new Error(`Kaizen API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllKaizenLeads() {
  const leads = [];
  let cursor = null;
  let generatedAt = null;

  do {
    const envelope = await fetchKaizenPage(cursor);
    generatedAt = generatedAt || envelope.generated_at;
    (envelope.data || []).forEach(raw => leads.push(normalizeLead(raw)));
    cursor = envelope.has_more ? envelope.next_cursor : null;
  } while (cursor);

  return { leads, generatedAt };
}

const MONDAY_FSBO_BOARD  = '6109998503';
const MONDAY_FSBO_GROUP  = 'group_mm2na3pg';

async function syncLeadsToMonday(leads, apiKey) {
  if (!apiKey || !leads.length) return 0;

  const BATCH = 10;
  let synced = 0;

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);

    const aliases = batch.map((lead, idx) => {
      const colVal = {
        text_mm2qzhf7: lead.address || '',
        text6:         lead.seller_name || '',
      };
      if (lead.price) colVal.numbers = String(lead.price);
      if (lead.phone) {
        const e164 = lead.phone.startsWith('+') ? lead.phone : `+1${lead.phone.replace(/\D/g, '')}`;
        colVal.seller_phone__1 = { phone: e164, countryShortName: 'US' };
      }
      if (lead.facebook_post_url) {
        colVal.link_mm2ytzv9 = { url: lead.facebook_post_url, text: 'Facebook Post' };
      }

      const colValLiteral = JSON.stringify(JSON.stringify(colVal));
      const itemName      = JSON.stringify(lead.address || 'Unknown Address');

      return `i${idx}: create_item(board_id: ${MONDAY_FSBO_BOARD}, group_id: "${MONDAY_FSBO_GROUP}", item_name: ${itemName}, column_values: ${colValLiteral}) { id }`;
    });

    try {
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query: `mutation { ${aliases.join('\n')} }` }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      if (data.errors) {
        console.error('[Monday] batch error:', data.errors[0]?.message);
      } else {
        synced += batch.length;

        // Add item updates with photo links for leads that have images
        const updateAliases = batch
          .map((lead, idx) => {
            if (!lead.images?.length) return null;
            const itemId = data.data?.[`i${idx}`]?.id;
            if (!itemId) return null;
            const photosText = lead.images.map((url, n) => `Photo ${n + 1}: ${url}`).join('\n');
            const body = JSON.stringify(photosText);
            return `u${idx}: create_update(item_id: ${itemId}, body: ${body}) { id }`;
          })
          .filter(Boolean);

        if (updateAliases.length > 0) {
          await fetch('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: apiKey },
            body: JSON.stringify({ query: `mutation { ${updateAliases.join('\n')} }` }),
            signal: AbortSignal.timeout(20000),
          }).catch(err => console.warn('[Monday] update failed:', err.message));
        }
      }
    } catch (err) {
      console.error('[Monday] batch failed:', err.message);
    }

    if (i + BATCH < leads.length) await new Promise(r => setTimeout(r, 400));
  }

  console.log(`[Monday] synced ${synced}/${leads.length} leads to FSBO Facebook Leads group`);
  return synced;
}

async function runKaizenFetch() {
  console.log(`[${new Date().toISOString()}] Running Kaizen FSBO fetch...`);

  if (!process.env.KAIZEN_API_KEY) {
    console.error('KAIZEN_API_KEY not set — skipping fetch.');
    return;
  }

  try {
    const { leads, generatedAt } = await fetchAllKaizenLeads();

    if (leads.length === 0) {
      console.log('Kaizen returned 0 leads.');
      return;
    }

    const batchDate = new Date().toISOString().slice(0, 10);

    // Delete today's existing batch so re-runs are idempotent
    await supabase.from('fsbo_leads').delete().eq('batch_date', batchDate);

    const rows = leads.map(l => ({ ...l, batch_date: batchDate, kaizen_generated_at: generatedAt }));

    const { error } = await supabase.from('fsbo_leads').insert(rows);
    if (error) throw error;

    // Sync to Monday.com
    await syncLeadsToMonday(leads, process.env.MONDAY_API_KEY);

    // Record last-fetch metadata in settings
    await supabase.from('settings').upsert([
      { key: 'kaizen_last_fetch_at',    value: new Date().toISOString() },
      { key: 'kaizen_last_fetch_count', value: String(leads.length) },
    ], { onConflict: 'key' });

    console.log(`✓ Kaizen fetch complete — ${leads.length} leads stored for ${batchDate}`);
  } catch (err) {
    console.error('Kaizen fetch failed:', err.message);
  }
}

async function shouldRunKaizenFetch() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'kaizen_fetch_hour')
    .maybeSingle();

  const raw = data?.value || '16:00';
  let configuredHour, configuredMinute;

  if (raw.includes(':')) {
    const [h, m] = raw.split(':');
    configuredHour = parseInt(h);
    configuredMinute = parseInt(m);
  } else {
    configuredHour = parseInt(raw);
    configuredMinute = 0;
  }

  // Get current time in America/New_York (handles EST/EDT automatically)
  const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return nowEST.getHours() === configuredHour && nowEST.getMinutes() === configuredMinute;
}

// ─── Cron ────────────────────────────────────────────────────────────────────

// Property transitions: run every hour at :00
cron.schedule('0 * * * *', () => {
  processAutoTransitions();
});

// Kaizen FSBO fetch: check every minute for exact time match
cron.schedule('* * * * *', async () => {
  if (await shouldRunKaizenFetch()) {
    runKaizenFetch();
  }
});

// Also run once on startup to catch any missed transitions
processAutoTransitions();

console.log('Ableman scheduler running. Property transitions: hourly. Kaizen fetch: checked every minute against configured EST time (default 16:00).');
