const fs = require('fs');
const path = require('path');

// Read Env Configurations safely
const envPath = path.join(__dirname, '../.env.local');
const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
let SUPABASE_KEY = '';
for (const line of envLines) {
  if (line.startsWith('SUPABASE_KEY=')) SUPABASE_KEY = line.split('=')[1].replace(/[\"'\r]/g, '').trim();
}
const SUPABASE_URL = 'https://ssxccorjqojjainjztan.supabase.co';

async function run() {
  try {
    console.log('Querying last 5 campaigns via Supabase REST API...');
    const campRes = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?select=*&order=created_at.desc&limit=5`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!campRes.ok) {
      console.error('Failed to fetch campaigns:', campRes.status, await campRes.text());
      return;
    }

    const campaigns = await campRes.json();
    console.log('\n--- CAMPAIGNS ---');
    campaigns.forEach(c => {
      console.log(`ID: ${c.id} | Action: ${c.action} | Status: ${c.status} | Scheduled At: ${c.scheduled_at} | Created At: ${c.created_at}`);
    });

    console.log('\nQuerying last 10 emails via Supabase REST API...');
    const emailRes = await fetch(`${SUPABASE_URL}/rest/v1/emails?select=*&order=created_at.desc&limit=10`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!emailRes.ok) {
      console.error('Failed to fetch emails:', emailRes.status, await emailRes.text());
      return;
    }

    const emails = await emailRes.json();
    console.log('\n--- EMAILS ---');
    emails.forEach(e => {
      console.log(`ID: ${e.id} | Campaign ID: ${e.campaign_id} | To: ${e.to_email} | Status: ${e.status} | Scheduled At: ${e.scheduled_at} | Followup Data: ${JSON.stringify(e.followup_data)}`);
    });

  } catch (err) {
    console.error('REST API error:', err.message);
  }
}

run();
