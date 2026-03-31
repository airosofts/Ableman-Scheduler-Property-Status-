require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function processStatusSchedules() {
  console.log(`[${new Date().toISOString()}] Running status schedule check...`);

  const { data: schedules, error } = await supabase
    .from('property_status_schedules')
    .select('id, property_id, to_status')
    .lte('scheduled_at', new Date().toISOString())
    .is('executed_at', null)
    .is('cancelled_at', null);

  if (error) {
    console.error('Failed to fetch schedules:', error.message);
    return;
  }

  if (!schedules || schedules.length === 0) {
    console.log('No due schedules.');
    return;
  }

  console.log(`Found ${schedules.length} due schedule(s).`);

  for (const schedule of schedules) {
    const { error: updateErr } = await supabase
      .from('properties')
      .update({
        property_status: schedule.to_status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schedule.property_id);

    if (updateErr) {
      console.error(`Failed to update property ${schedule.property_id}:`, updateErr.message);
      continue;
    }

    await supabase
      .from('property_status_schedules')
      .update({ executed_at: new Date().toISOString() })
      .eq('id', schedule.id);

    console.log(`✓ Property ${schedule.property_id} → ${schedule.to_status}`);
  }
}

// Run every hour at :00
cron.schedule('0 * * * *', processStatusSchedules);

// Also run once on startup to catch any missed schedules
processStatusSchedules();

console.log('Ableman scheduler running. Checks every hour.');
