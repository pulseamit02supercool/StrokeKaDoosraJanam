const fs = require('fs');
const envLines = fs.readFileSync('.env.local', 'utf8').split('\n');
let SUPABASE_KEY = '';
for (const line of envLines) {
  if (line.startsWith('SUPABASE_KEY=')) SUPABASE_KEY = line.split('=')[1].replace(/[\"'\r]/g, '');
}
const SUPABASE_URL = 'https://ssxccorjqojjainjztan.supabase.co';

async function run() {
  const res = await fetch(SUPABASE_URL + '/rest/v1/emails?select=*&order=id.desc&limit=100', {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  const data = await res.json();
  const summary = { pending: 0, sent: 0, failed: 0, processing: 0, skipped_replied: 0 };
  data.forEach(d => {
    summary[d.status] = (summary[d.status] || 0) + 1;
  });
  console.log('--- Last 100 Emails Status Summary ---');
  console.log(summary);
  console.log('\n--- Recent Anomalies ---');
  console.log(data.filter(d => d.status !== 'sent').slice(0, 15).map(o => ({ id: o.id, to: o.to_email, status: o.status, error: o.error, sched: o.scheduled_at })));
}
run();
