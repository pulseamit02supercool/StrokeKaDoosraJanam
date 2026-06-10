const path = require('path');
const jwt = require('jsonwebtoken');

// 1. Mock DB state
let emailsDb = [];
let databaseInserts = [];
let databaseSelectsCount = 0;

const mockSupabase = {
  from: (table) => {
    let eqFilters = [];
    
    const query = {
      select: () => query,
      eq: (field, val) => {
        eqFilters.push({ field, val });
        return query;
      },
      insert: (payload) => {
        databaseInserts.push({ table, payload });
        return Promise.resolve({ error: null });
      },
      then: (resolve, reject) => {
        databaseSelectsCount++;
        // Handle select query
        if (table === 'emails') {
          // Filter emailsDb based on eqFilters
          let filtered = [...emailsDb];
          for (const filter of eqFilters) {
            filtered = filtered.filter(item => {
              if (filter.field === 'user_id') return item.user_id === filter.val;
              if (filter.field === 'is_followup') return item.is_followup === filter.val;
              if (filter.field === 'status') return item.status === filter.val;
              if (filter.field === 'campaign_id') return item.campaign_id === filter.val;
              if (filter.field === 'to_email') return item.to_email === filter.val;
              return true;
            });
          }
          resolve({ data: filtered, error: null });
        } else {
          resolve({ data: [], error: null });
        }
      }
    };
    return query;
  }
};

// Inject mock into require cache
const apiSupabasePath = path.resolve(__dirname, '../api/_lib/supabase.js');
const renderSupabasePath = path.resolve(__dirname, '../render-server/lib/supabase.js');
require.cache[apiSupabasePath] = { exports: { supabase: mockSupabase } };
require.cache[renderSupabasePath] = { exports: { supabase: mockSupabase } };

// Mock environment variables
process.env.JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_KEY = 'test-key';

// Require handlers
const apiRepairHandler = require('../api/campaigns/repair');
const renderCampaignsRouter = require('../render-server/routes/campaigns');

// Assertion helper
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}. Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
  }
  console.log(`  PASS: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`  PASS: ${message}`);
}

async function runTests() {
  console.log('--- START CAMPAIGN REPAIR ENDPOINT TESTS ---');
  
  const token = jwt.sign({ id: 'user-123' }, 'test-secret');

  const runApiRepair = async () => {
    databaseInserts = [];
    const req = {
      method: 'POST',
      headers: { cookie: `stroke_token=${token}` }
    };
    const res = {
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.body = data; return this; }
    };
    await apiRepairHandler(req, res);
    assertEqual(res.statusCode || 200, 200, 'API Repair handler should return 200');
    return { body: res.body, inserts: databaseInserts };
  };

  const runExpressRepair = async () => {
    databaseInserts = [];
    const req = {
      method: 'POST',
      url: '/repair',
      headers: { cookie: `stroke_token=${token}` }
    };
    const res = {
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.body = data; return this; }
    };

    await new Promise((resolve, reject) => {
      const originalJson = res.json;
      res.json = function(data) {
        originalJson.call(this, data);
        resolve();
        return this;
      };
      
      renderCampaignsRouter(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    assertEqual(res.statusCode || 200, 200, 'Express Router Repair should return 200');
    return { body: res.body, inserts: databaseInserts };
  };

  // ==========================================
  // CASE 1: Main email is sent, has followup steps, but NO followups exist in DB.
  // ==========================================
  console.log('\n--- CASE 1: Missing followups should be spawned ---');
  emailsDb = [
    {
      id: 'email-main-sent-1',
      campaign_id: 'campaign-123',
      user_id: 'user-123',
      to_email: 'user@example.com',
      is_followup: false,
      scheduled_at: '2026-06-09T10:00:00.000Z',
      status: 'sent',
      sent_at: '2026-06-09T10:05:00.000Z',
      followup_data: {
        timezone: 'Europe/London',
        steps: [
          { dayOffset: 1, time: '09:00', body: 'Step 1 Body' },
          { dayOffset: 2, time: '14:30', body: 'Step 2 Body' }
        ]
      }
    }
  ];

  // API Repair Run
  let resApi = await runApiRepair();
  assertEqual(resApi.body.spawned, 2, 'API: Should report 2 spawned followups');
  assertEqual(resApi.inserts.length, 1, 'API: Should call insert once');
  let inserted = resApi.inserts[0].payload;
  assertEqual(inserted.length, 2, 'API: Should insert 2 emails');
  assertEqual(inserted[0].to_email, 'user@example.com', 'API: Recipient matches');
  assertEqual(inserted[0].is_followup, true, 'API: Is follow-up email');
  // Europe/London BST (UTC+1): 09:00 BST -> 08:00 UTC. June 9 10:05 + 1 day = June 10 09:00 BST = June 10 08:00 UTC. 
  // Since 08:00 UTC is less than 24h from June 9 10:05 UTC, it bumps to June 11 08:00 UTC due to min delay rule.
  assertEqual(inserted[0].scheduled_at, '2026-06-11T08:00:00.000Z', 'API: Followup 1 scheduled date matches minimum delay check');
  assertEqual(inserted[1].scheduled_at, '2026-06-11T13:30:00.000Z', 'API: Followup 2 scheduled date matches');

  // Express Repair Run
  let resExpress = await runExpressRepair();
  assertEqual(resExpress.body.spawned, 2, 'Express: Should report 2 spawned followups');
  assertEqual(resExpress.inserts.length, 1, 'Express: Should call insert once');

  // ==========================================
  // CASE 2: Followup emails ALREADY exist in the database.
  // ==========================================
  console.log('\n--- CASE 2: Already existing followups should NOT be duplicated ---');
  emailsDb = [
    {
      id: 'email-main-sent-2',
      campaign_id: 'campaign-123',
      user_id: 'user-123',
      to_email: 'user@example.com',
      is_followup: false,
      scheduled_at: '2026-06-09T10:00:00.000Z',
      status: 'sent',
      sent_at: '2026-06-09T10:05:00.000Z',
      followup_data: {
        timezone: 'Europe/London',
        steps: [
          { dayOffset: 1, time: '09:00', body: 'Step 1 Body' }
        ]
      }
    },
    {
      id: 'email-fup-existing',
      campaign_id: 'campaign-123',
      user_id: 'user-123',
      to_email: 'user@example.com',
      is_followup: true,
      scheduled_at: '2026-06-11T08:00:00.000Z',
      status: 'pending',
      sent_at: null
    }
  ];

  resApi = await runApiRepair();
  assertEqual(resApi.body.spawned, 0, 'API: Should report 0 spawned followups');
  assertEqual(resApi.inserts.length, 0, 'API: Should not insert any records');

  resExpress = await runExpressRepair();
  assertEqual(resExpress.body.spawned, 0, 'Express: Should report 0 spawned followups');
  assertEqual(resExpress.inserts.length, 0, 'Express: Should not insert any records');

  console.log('\nAll campaign repair endpoint tests passed successfully!');
}

runTests().catch(err => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
