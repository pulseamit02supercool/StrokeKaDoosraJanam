const { supabase } = require('../_lib/supabase');
const jwt = require('jsonwebtoken');
const { getUTCFromTimezone } = require('../_lib/timezone');

module.exports = async (req, res) => {
  try {
    const dbUrl = process.env.SUPABASE_URL;
    const dbKeyLength = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.length : 0;
    const jwtSecret = process.env.JWT_SECRET;

    // Decode token if present
    let loggedInUserId = null;
    let strokeToken = req.cookies?.stroke_token;
    if (!strokeToken) {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        strokeToken = authHeader.split(' ')[1];
      }
    }

    if (strokeToken) {
      try {
        const decoded = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
        loggedInUserId = decoded ? decoded.id : null;
      } catch (e) {
        loggedInUserId = 'Error: ' + e.message;
      }
    }
    
    // Check connection to campaigns table
    const { data: campaigns, error: campErr } = await supabase
      .from('campaigns')
      .select('id, user_id, created_at')
      .limit(50);
      
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('id, user_id, status, is_followup, followup_data, campaign_id, to_email, sent_at')
      .limit(100);

    const { data: dipsikEmails } = await supabase
      .from('emails')
      .select('*')
      .eq('to_email', 'dipsik@thoughtworks.com');

    // Get unique user_ids from tables
    const campaignsUserIds = campaigns ? [...new Set(campaigns.map(c => c.user_id))] : [];
    const emailsUserIds = emails ? [...new Set(emails.map(e => e.user_id))] : [];

    // Count repair candidates globally (unfiltered by user)
    let globalCandidatesCount = 0;
    if (emails) {
      for (const email of emails) {
        if (!email.is_followup && email.status === 'sent') {
          const hasFollowupData = email.followup_data && (Array.isArray(email.followup_data) || (typeof email.followup_data === 'object' && Array.isArray(email.followup_data.steps)));
          if (hasFollowupData) {
            globalCandidatesCount++;
          }
        }
      }
    }

    // Run repair if requested
    let repairLogs = [];
    let spawnedCount = 0;
    if (req.query.run_repair === 'true') {
      if (!loggedInUserId || String(loggedInUserId).startsWith('Error')) {
        repairLogs.push('Cannot run repair: User not authenticated');
      } else {
        repairLogs.push(`Starting repair for user: ${loggedInUserId}`);
        const { data: sentMains, error: fetchErr } = await supabase
          .from('emails')
          .select('*')
          .eq('user_id', loggedInUserId)
          .eq('is_followup', false)
          .eq('status', 'sent');

        if (fetchErr) {
          repairLogs.push(`Fetch sent mains error: ${fetchErr.message}`);
        } else {
          repairLogs.push(`Found ${sentMains.length} sent main emails`);
          const followupsToInsert = [];

          for (const email of sentMains) {
            const hasFollowupData = email.followup_data && (Array.isArray(email.followup_data) || (typeof email.followup_data === 'object' && Array.isArray(email.followup_data.steps)));
            if (!hasFollowupData) {
              repairLogs.push(`Email ${email.id} skipped: no followup data`);
              continue;
            }

            // Check if followups already exist for this email/recipient
            const { data: existingFups, error: fupErr } = await supabase
              .from('emails')
              .select('id')
              .eq('campaign_id', email.campaign_id)
              .eq('to_email', email.to_email)
              .eq('is_followup', true);

            if (fupErr) {
              repairLogs.push(`Error checking existing followups for ${email.to_email}: ${fupErr.message}`);
              continue;
            }

            if (existingFups && existingFups.length > 0) {
              repairLogs.push(`Email ${email.id} to ${email.to_email} skipped: ${existingFups.length} followups already exist`);
              continue;
            }

            const steps = Array.isArray(email.followup_data)
              ? email.followup_data
              : (email.followup_data.steps || []);
            const recipientTz = (typeof email.followup_data === 'object' && email.followup_data.timezone)
              ? email.followup_data.timezone
              : 'Asia/Kolkata';

            repairLogs.push(`Email ${email.id} to ${email.to_email}: spawning ${steps.length} steps in tz ${recipientTz}`);

            for (const step of steps) {
              const stepTz = step.timezone || recipientTz;
              const sendAt = await getUTCFromTimezone(step.dayOffset, step.time, stepTz, email.sent_at);

              followupsToInsert.push({
                campaign_id: email.campaign_id,
                user_id: email.user_id,
                to_email: email.to_email,
                cc_email: email.cc_email,
                subject: step.subject || email.subject,
                body: step.body || email.body,
                thread_id: email.thread_id,
                rfc_message_id: email.rfc_message_id,
                scheduled_at: sendAt.toISOString(),
                status: 'pending',
                is_followup: true
              });
              spawnedCount++;
            }
          }

          if (followupsToInsert.length > 0) {
            const { error: insertErr } = await supabase.from('emails').insert(followupsToInsert);
            if (insertErr) {
              repairLogs.push(`Insert error: ${insertErr.message}`);
            } else {
              repairLogs.push(`Successfully inserted ${followupsToInsert.length} follow-up emails`);
            }
          } else {
            repairLogs.push('No followups to insert');
          }
        }
      }
    }

    res.status(200).json({
      supabase_url: dbUrl,
      supabase_key_length: dbKeyLength,
      jwt_secret_configured: !!jwtSecret,
      logged_in_user_id: loggedInUserId,
      campaigns_user_ids: campaignsUserIds,
      emails_user_ids: emailsUserIds,
      global_repair_candidates_count: globalCandidatesCount,
      repair_executed: req.query.run_repair === 'true',
      repair_spawned_count: spawnedCount,
      repair_logs: repairLogs,
      campaigns_error: campErr ? campErr.message : null,
      campaigns_count: campaigns ? campaigns.length : 0,
      campaigns_sample: campaigns || [],
      emails_error: emailErr ? emailErr.message : null,
      emails_count: emails ? emails.length : 0,
      emails_sample: emails || [],
      dipsik_emails: dipsikEmails || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
