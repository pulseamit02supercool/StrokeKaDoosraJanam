const path = require('path');
const jwt = require('jsonwebtoken');

// 1. Mock Supabase Client to capture inserted records
let insertedEmails = [];
const mockSupabase = {
  from: (table) => ({
    insert: (data) => {
      if (table === 'emails') {
        insertedEmails = data;
        return Promise.resolve({ error: null });
      }
      // Mock campaign insert returning a dummy campaign object
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'camp-123' }, error: null })
        })
      };
    }
  })
};

// Inject mock into require cache for both api and render-server paths
const apiSupabasePath = path.resolve(__dirname, '../api/_lib/supabase.js');
const renderSupabasePath = path.resolve(__dirname, '../render-server/lib/supabase.js');
require.cache[apiSupabasePath] = { exports: { supabase: mockSupabase } };
require.cache[renderSupabasePath] = { exports: { supabase: mockSupabase } };

// Mock environment variables
process.env.JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_KEY = 'test-key';

// 2. Mock system clock to June 9, 2026, 05:00:00 UTC (10:30 AM IST)
// This makes 11:00 AM IST (scheduledAt) in the future for the server validation,
// while letting Tokyo be at 2:00 PM (> 11:00 AM) and London/New York be at 6:00 AM and 1:00 AM (<= 11:00 AM).
const mockedTime = new Date('2026-06-09T05:00:00Z').getTime();
const RealDate = Date;
class MockDate extends Date {
  constructor(...args) {
    if (args.length === 0) {
      super(mockedTime);
    } else {
      super(...args);
    }
  }
  static now() {
    return mockedTime;
  }
}
global.Date = MockDate;

// Require the controllers
const apiCreateHandler = require('../api/campaigns/create');
const renderCreateRouter = require('../render-server/routes/campaigns');

// Assert helper
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message}. Expected: "${expected}", Got: "${actual}"`);
  }
  console.log(`  PASS: ${message}`);
}

async function runTests() {
  console.log('--- START TIMEZONE SCHEDULING RULE TESTS ---');
  console.log(`Mocked Current Time: ${new Date().toISOString()}`);
  
  const token = jwt.sign({ id: 'user-123' }, 'test-secret');
  
  const reqBody = {
    action: 'bulkSend',
    subjectTemplate: 'Hello {{Name}}',
    bodyTemplate: 'Hi {{Name}}, location {{Location}}',
    csvData: [
      ['tokyo@test.com', 'Tokyo User', 'Tokyo'],       // UTC+9 -> Local time: 2:00 PM (> 11am) -> should be next day (June 10) at 11:00 AM Tokyo time (02:00 UTC)
      ['london@test.com', 'London User', 'London'],    // UTC+1 -> Local time: 6:00 AM (<= 11am) -> should be today (June 9) at 11:00 AM London time (10:00 UTC)
      ['ny@test.com', 'NY User', 'New York']           // UTC-4 -> Local time: 1:00 AM (<= 11am) -> should be today (June 9) at 11:00 AM New York time (15:00 UTC)
    ],
    headers: ['Email', 'Name', 'Location'],
    scheduledAt: '2026-06-09T11:00', // Target scheduled local time: 11:00 AM
    timezoneMode: 'recipient',
    timezoneColumn: 'Location',
    timezoneMappings: {
      'Tokyo': 'Asia/Tokyo',
      'London': 'Europe/London',
      'New York': 'America/New_York'
    }
  };

  const verifyResults = (emails, origin) => {
    console.log(`Verifying scheduled times for ${origin}...`);
    assertEqual(emails.length, 3, 'Should insert 3 emails');

    // 1. Tokyo
    const tokyoEmail = emails.find(e => e.to_email === 'tokyo@test.com');
    assertEqual(tokyoEmail.scheduled_at, '2026-06-10T02:00:00.000Z', 'Tokyo (UTC+9) should shift to June 10 at 11:00 JST (02:00 UTC)');

    // 2. London
    const londonEmail = emails.find(e => e.to_email === 'london@test.com');
    assertEqual(londonEmail.scheduled_at, '2026-06-09T10:00:00.000Z', 'London (UTC+1) should stay on June 9 at 11:00 BST (10:00 UTC)');

    // 3. New York
    const nyEmail = emails.find(e => e.to_email === 'ny@test.com');
    assertEqual(nyEmail.scheduled_at, '2026-06-09T15:00:00.000Z', 'New York (UTC-4) should stay on June 9 at 11:00 EDT (15:00 UTC)');
  };

  // --- TEST 1: API CREATE HANDLER ---
  console.log('\nRunning test on Vercel handler (api/campaigns/create.js)...');
  insertedEmails = [];
  const apiReq = {
    method: 'POST',
    headers: {
      cookie: `stroke_token=${token}`
    },
    body: reqBody
  };
  const apiRes = {
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      this.body = data;
      return this;
    }
  };
  await apiCreateHandler(apiReq, apiRes);
  if (apiRes.statusCode && apiRes.statusCode !== 200) {
    console.error('API Error Response Body:', apiRes.body);
  }
  assertEqual(apiRes.statusCode || 200, 200, 'API Handler status should be 200');
  verifyResults(insertedEmails, 'api/campaigns/create.js');

  // --- TEST 2: RENDER-SERVER EXPRESS ROUTER ---
  console.log('\nRunning test on Express router (render-server/routes/campaigns.js)...');
  insertedEmails = [];
  const renderReq = {
    method: 'POST',
    url: '/create',
    headers: {
      cookie: `stroke_token=${token}`
    },
    body: reqBody
  };
  const renderRes = {
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      this.body = data;
      return this;
    }
  };

  await new Promise((resolve, reject) => {
    // Intercept response finish
    const originalJson = renderRes.json;
    renderRes.json = function(data) {
      originalJson.call(this, data);
      resolve();
      return this;
    };
    
    renderCreateRouter(renderReq, renderRes, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  if (renderRes.statusCode && renderRes.statusCode !== 200) {
    console.error('Express Router Error Response Body:', renderRes.body);
  }
  assertEqual(renderRes.statusCode || 200, 200, 'Express Router status should be 200');
  verifyResults(insertedEmails, 'render-server/routes/campaigns.js');

  console.log('\nTimezone scheduling rule tests passed successfully for both systems!');
}

runTests().catch(err => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
