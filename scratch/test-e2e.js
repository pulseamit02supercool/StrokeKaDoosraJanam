const fs = require('fs');

// Set up environment key mock so the geocoder attempts the API call
process.env.GOOGLE_MAPS_API_KEY = 'test-mock-key';

// Mock global.fetch to intercept and resolve Google Maps API geocoding & timezone calls
global.fetch = async (url) => {
  const urlStr = String(url).toLowerCase();
  
  if (urlStr.includes('maps.googleapis.com/maps/api/geocode/json')) {
    let lat = 0, lng = 0;
    if (urlStr.includes('london')) { lat = 51.5074; lng = -0.1278; }
    else if (urlStr.includes('new%20york') || urlStr.includes('ny')) { lat = 40.7128; lng = -74.0060; }
    else if (urlStr.includes('tokyo')) { lat = 35.6762; lng = 139.6503; }
    
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [{
          geometry: { location: { lat, lng } }
        }]
      })
    };
  }
  
  if (urlStr.includes('maps.googleapis.com/maps/api/timezone/json')) {
    let timeZoneId = 'UTC';
    if (urlStr.includes('51.5074,-0.1278') || urlStr.includes('london')) { timeZoneId = 'Europe/London'; }
    else if (urlStr.includes('40.7128,-74.006') || urlStr.includes('new%20york') || urlStr.includes('ny')) { timeZoneId = 'America/New_York'; }
    else if (urlStr.includes('35.6762,139.6503') || urlStr.includes('tokyo')) { timeZoneId = 'Asia/Tokyo'; }
    
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        timeZoneId
      })
    };
  }
  
  throw new Error(`Unexpected fetch URL in test: ${url}`);
};

const { getUTCFromTimezone, resolveTimezoneOffset } = require('../api/_lib/timezone');

// Read Env Configurations safely if file exists
let SUPABASE_KEY = '';
if (fs.existsSync('.env.local')) {
  const envLines = fs.readFileSync('.env.local', 'utf8').split('\n');
  for (const line of envLines) {
    if (line.startsWith('SUPABASE_KEY=')) SUPABASE_KEY = line.split('=')[1].replace(/[\"'\r]/g, '').trim();
  }
}
const SUPABASE_URL = 'https://ssxccorjqojjainjztan.supabase.co';

function assert(condition, message) {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
  console.log('  PASS:', message);
}

async function run() {
  console.log('Starting E2E Campaign Timezone Verification...');
  
  // Test Data
  const headers = ['Email', 'Name', 'Location'];
  const csvData = [
    ['ny@test.com', 'NY User', 'New York'],
    ['ldn@test.com', 'London User', 'London'],
    ['tyo@test.com', 'Tokyo User', 'Tokyo'],
    ['ist@test.com', 'IST User', 'UnknownLocation'] // Fallback standard route
  ];
  
  const timezoneMode = 'recipient';
  const timezoneColumn = 'Location';
  const timezoneMappings = {
    'New York': 'America/New_York',
    'London': 'Europe/London',
    'Tokyo': 'Asia/Tokyo',
    'UnknownLocation': 'Asia/Kolkata'
  };
  
  const scheduledAt = '2026-06-01T10:00'; // Target: 10:00 AM local wall-clock time
  
  const emailHeaderIdx = headers.indexOf('Email');
  const locationColIdx = headers.indexOf(timezoneColumn);
  
  const emailsToInsert = [];
  const testUserId = '00000000-0000-0000-0000-000000000000'; // Mock/test user ID
  const testCampaignId = '00000000-0000-0000-0000-000000000001'; // Mock/test campaign ID
  
  console.log('\n1. Resolving scheduled times per recipient...');
  
  for (const row of csvData) {
    const toEmail = row[emailHeaderIdx];
    const rawLocation = row[locationColIdx];
    
    let recipientTz = 'Asia/Kolkata';
    if (timezoneMode === 'recipient' && rawLocation) {
      if (timezoneMappings && timezoneMappings[rawLocation]) {
        recipientTz = timezoneMappings[rawLocation];
      }
    }
    
    // Parse scheduled local wall clock time into UTC
    let sendAt;
    const match = scheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (match) {
      const y = Number(match[1]);
      const m = Number(match[2]) - 1;
      const d = Number(match[3]);
      const hh = Number(match[4]);
      const mm = Number(match[5]);
      
      const wallClockUTC = new Date(Date.UTC(y, m, d, hh, mm, 0, 0));
      const offsetMinutes = await resolveTimezoneOffset(recipientTz, wallClockUTC);
      sendAt = new Date(wallClockUTC.getTime() - offsetMinutes * 60000);
    }
    
    console.log(`  - Recipient: ${toEmail} | Location: ${rawLocation} -> Resolved Zone: ${recipientTz} | Scheduled UTC: ${sendAt.toISOString()}`);
    
    emailsToInsert.push({
      campaign_id: testCampaignId,
      user_id: testUserId,
      to_email: toEmail,
      subject: 'E2E Test Subject',
      body: 'E2E Test Body',
      scheduled_at: sendAt.toISOString(),
      status: 'pending',
      is_followup: false,
      followup_data: {
        timezone: recipientTz,
        steps: [
          { dayOffset: 1, time: '11:00', body: 'E2E Followup Step' }
        ]
      }
    });
  }
  
  // Verify offsets are correct
  // New York (America/New_York) at June 1 2026 is EDT (UTC-4) -> 10:00 AM local is 2:00 PM UTC (14:00)
  assert(emailsToInsert[0].scheduled_at.endsWith('14:00:00.000Z'), 'New York schedule should translate to 14:00 UTC. Actual: ' + emailsToInsert[0].scheduled_at);

  // London (Europe/London) at June 1 2026 is BST (UTC+1) -> 10:00 AM local is 9:00 AM UTC (09:00)
  assert(emailsToInsert[1].scheduled_at.endsWith('09:00:00.000Z'), 'London schedule should translate to 09:00 UTC. Actual: ' + emailsToInsert[1].scheduled_at);

  // Tokyo (Asia/Tokyo) is JST (UTC+9) -> 10:00 AM local is 1:00 AM UTC (01:00)
  assert(emailsToInsert[2].scheduled_at.endsWith('01:00:00.000Z'), 'Tokyo schedule should translate to 01:00 UTC. Actual: ' + emailsToInsert[2].scheduled_at);

  // Fallback (Asia/Kolkata) is IST (UTC+5.5) -> 10:00 AM local is 4:30 AM UTC (04:30)
  assert(emailsToInsert[3].scheduled_at.endsWith('04:30:00.000Z'), 'Fallback IST schedule should translate to 04:30 UTC. Actual: ' + emailsToInsert[3].scheduled_at);

  console.log('\n2. Testing followup scheduling calculations...');
  // Followup is Day 1 at 11:00 JST for Tokyo (11:00 JST is 2:00 AM UTC)
  const tokyoTz = emailsToInsert[2].followup_data.timezone;
  const tokyoStep = emailsToInsert[2].followup_data.steps[0];
  const tokyoFollowupSendAt = await getUTCFromTimezone(tokyoStep.dayOffset, tokyoStep.time, tokyoTz);
  console.log(`  - Tokyo Followup Step Scheduled UTC: ${tokyoFollowupSendAt.toISOString()}`);
  
  const formattedTokyoFollowup = tokyoFollowupSendAt.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: 'numeric', hour12: false });
  assert(formattedTokyoFollowup.trim() === '11:00', 'Tokyo followup local time must format back to exactly 11:00 JST. Actual: ' + formattedTokyoFollowup);

  console.log('\nE2E TIMEZONE VALIDATION SUCCESSFUL!');
}

run().catch(err => {
  console.error('\nE2E VALIDATION FAILURE:', err.message);
  process.exit(1);
});
