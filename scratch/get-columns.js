const fs = require('fs');
const envLines = fs.readFileSync('.env.local', 'utf8').split('\n');
let SUPABASE_KEY = '';
for (const line of envLines) {
  if (line.startsWith('SUPABASE_KEY=')) SUPABASE_KEY = line.split('=')[1].replace(/[\"'\r]/g, '').trim();
}
const SUPABASE_URL = 'https://ssxccorjqojjainjztan.supabase.co';

async function run() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const schema = await res.json();
    console.log('Response keys:', Object.keys(schema));
    if (schema.paths) {
      console.log('Paths:', Object.keys(schema.paths));
    }
  } catch (err) {
    console.error('Error fetching OpenAPI schema:', err.message);
  }
}
run();
