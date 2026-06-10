const path = require('path');
const jwt = require('jsonwebtoken');

// 1. Mock DB state
let campaignDb = {
  id: 'campaign-123',
  user_id: 'user-123',
  csv_data: [
    ['user@example.com', 'Example User', 'London']
  ],
  headers: ['Email', 'Name', 'Location'],
  subject_template: 'Hello {{Name}}',
  body_template: 'Hi {{Name}}, location {{Location}}',
  cc_template: ''
};

let emailsDb = [];
let databaseUpdates = [];

const mockSupabase = {
  from: (table) => {
    return {
      select: (selectStr) => {
        return {
          eq: (field1, val1) => {
            return {
              eq: (field2, val2) => {
                return {
                  single: () => {
                    if (table === 'campaigns' && val1 === 'campaign-123' && val2 === 'user-123') {
                      return Promise.resolve({ data: campaignDb, error: null });
                    }
                    return Promise.resolve({ data: null, error: new Error('Not found') });
                  }
                };
              },
              single: () => {
                if (table === 'campaigns' && val1 === 'campaign-123') {
                  return Promise.resolve({ data: campaignDb, error: null });
                }
                return Promise.resolve({ data: null, error: new Error('Not found') });
              }
            };
          },
          eq: (field, val) => {
            if (table === 'emails' && field === 'campaign_id' && val === 'campaign-123') {
              return Promise.resolve({ data: emailsDb, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }
        };
      },
      update: (payload) => {
        return {
          eq: (field, val) => {
            databaseUpdates.push({ table, payload, eqField: field, eqVal: val });
            return Promise.resolve({ data: [payload], error: null });
          }
        };
      }
    };
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
const apiUpdateHandler = require('../api/campaigns/update');
const renderCampaignsRouter = require('../render-server/routes/campaigns');

// Assertion helper
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}. Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
  }
  console.log(`  PASS: ${message}`);
}

async function runTests() {
  console.log('--- START CAMPAIGN UPDATE TIMEZONE & SCHEDULE TESTS ---');
  
  const token = jwt.sign({ id: 'user-123' }, 'test-secret');

  const updateBody = {
    campaignId: 'campaign-123',
    subjectTemplate: 'Updated {{Name}}',
    bodyTemplate: 'Updated Body for {{Name}}',
    ccTemplate: 'cc@example.com',
    followups: [
      { dayOffset: 1, time: '09:00', bodyTemplate: 'FUP Step 1 {{Name}}' },
      { dayOffset: 2, time: '14:30', bodyTemplate: 'FUP Step 2 {{Name}}' }
    ]
  };

  const runApiUpdate = async () => {
    databaseUpdates = [];
    const req = {
      method: 'POST',
      headers: { cookie: `stroke_token=${token}` },
      body: updateBody
    };
    const res = {
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.body = data; return this; }
    };
    await apiUpdateHandler(req, res);
    assertEqual(res.statusCode || 200, 200, 'API Update handler should return 200');
    return databaseUpdates;
  };

  const runExpressUpdate = async () => {
    databaseUpdates = [];
    const req = {
      method: 'POST',
      url: '/update',
      headers: { cookie: `stroke_token=${token}` },
      body: updateBody
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

    assertEqual(res.statusCode || 200, 200, 'Express Router Update should return 200');
    return databaseUpdates;
  };

  // ==========================================
  // CASE 1: Main email is pending, followups are configured.
  // ==========================================
  console.log('\n--- CASE 1: Main email is pending ---');
  emailsDb = [
    {
      id: 'email-main-1',
      campaign_id: 'campaign-123',
      to_email: 'user@example.com',
      is_followup: false,
      scheduled_at: '2026-06-09T10:00:00.000Z',
      status: 'pending',
      sent_at: null,
      followup_data: { timezone: 'Europe/London', steps: [] } // Existing wrapped format
    }
  ];

  let updates = await runApiUpdate();
  let mainEmailUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-main-1');
  assert(mainEmailUpdate !== undefined, 'Main email update should be found');
  assertEqual(mainEmailUpdate.payload.followup_data.timezone, 'Europe/London', 'Timezone must be preserved as Europe/London');
  assert(Array.isArray(mainEmailUpdate.payload.followup_data.steps), 'steps must be an array');
  assertEqual(mainEmailUpdate.payload.followup_data.steps.length, 2, 'Should have 2 followup steps');
  assertEqual(mainEmailUpdate.payload.followup_data.steps[0].timezone, 'Europe/London', 'Step 1 should inherit timezone');
  assertEqual(mainEmailUpdate.payload.followup_data.steps[0].time, '09:00', 'Step 1 time should be updated');

  // Verify Express router behaves exactly the same
  updates = await runExpressUpdate();
  mainEmailUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-main-1');
  assert(mainEmailUpdate !== undefined, 'Express: Main email update should be found');
  assertEqual(mainEmailUpdate.payload.followup_data.timezone, 'Europe/London', 'Express: Timezone must be preserved as Europe/London');
  assertEqual(mainEmailUpdate.payload.followup_data.steps[0].timezone, 'Europe/London', 'Express: Step 1 should inherit timezone');

  // ==========================================
  // CASE 2: Legacy campaign where followup_data was a plain array.
  // ==========================================
  console.log('\n--- CASE 2: Legacy array followup_data ---');
  emailsDb = [
    {
      id: 'email-main-2',
      campaign_id: 'campaign-123',
      to_email: 'user@example.com',
      is_followup: false,
      scheduled_at: '2026-06-09T10:00:00.000Z',
      status: 'pending',
      sent_at: null,
      followup_data: [] // Legacy array format
    }
  ];

  updates = await runApiUpdate();
  mainEmailUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-main-2');
  assertEqual(mainEmailUpdate.payload.followup_data.timezone, 'Asia/Kolkata', 'Timezone should fall back to Asia/Kolkata for legacy array');

  updates = await runExpressUpdate();
  mainEmailUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-main-2');
  assertEqual(mainEmailUpdate.payload.followup_data.timezone, 'Asia/Kolkata', 'Express: Timezone should fall back to Asia/Kolkata for legacy array');

  // ==========================================
  // CASE 3: Main email was sent. We update already spawned pending follow-up emails.
  // We want to verify scheduled_at is correctly recalculated based on main.sent_at.
  // ==========================================
  console.log('\n--- CASE 3: Main email was sent, recalculating followups ---');
  emailsDb = [
    {
      id: 'email-main-3',
      campaign_id: 'campaign-123',
      to_email: 'user@example.com',
      is_followup: false,
      scheduled_at: '2026-06-09T10:00:00.000Z',
      status: 'sent',
      sent_at: '2026-06-09T10:05:00.000Z', // Parent sent_at is June 9, 2026 at 10:05:00 UTC
      followup_data: { timezone: 'Europe/London', steps: [] }
    },
    {
      id: 'email-fup-1',
      campaign_id: 'campaign-123',
      to_email: 'user@example.com',
      is_followup: true,
      scheduled_at: '2026-06-10T10:00:00.000Z',
      status: 'pending',
      sent_at: null
    }
  ];

  // API update:
  updates = await runApiUpdate();
  let fupUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-fup-1');
  assert(fupUpdate !== undefined, 'Follow-up email update should be found');
  // Europe/London:
  // Parent sent at: 2026-06-09T10:05:00.000Z (June 9 is BST, UTC+1, local time: 11:05:00 BST).
  // Followup dayOffset: 1 -> scheduled for June 10.
  // Followup time: '09:00' -> scheduled for June 10, 09:00 BST.
  // June 10, 09:00 BST is 08:00 UTC (2026-06-10T08:00:00.000Z).
  assertEqual(fupUpdate.payload.scheduled_at, '2026-06-10T08:00:00.000Z', 'Followup scheduled_at should be June 10 at 08:00 UTC (09:00 BST)');

  // Express router update:
  updates = await runExpressUpdate();
  fupUpdate = updates.find(u => u.table === 'emails' && u.eqVal === 'email-fup-1');
  assert(fupUpdate !== undefined, 'Express: Follow-up email update should be found');
  assertEqual(fupUpdate.payload.scheduled_at, '2026-06-10T08:00:00.000Z', 'Express: Followup scheduled_at should be June 10 at 08:00 UTC (09:00 BST)');

  console.log('\nAll campaign update timezone and schedule tests passed successfully!');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`  PASS: ${message}`);
}

runTests().catch(err => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
