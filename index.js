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

// Run every hour at :00
cron.schedule('0 * * * *', processAutoTransitions);

// Also run once on startup to catch any missed transitions
processAutoTransitions();

console.log('Ableman scheduler running. Checks every hour.');
