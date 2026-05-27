const { supabase } = require('../lib/supabase');
const { refreshAccessToken, sendEmail, checkForReply } = require('../lib/gmail');
const { getUTCFromTimezone } = require('../lib/timezone');

/**
 * Process the email queue.
 * On Render (no 10-second timeout), we can safely process up to 100 emails per batch.
 */
async function processEmailQueue() {
  try {
    // 1. Fetch pending emails whose scheduled time has passed
    // Raised from 15 → 100 since Render has no execution timeout
    const { data: candidates, error } = await supabase
      .from('emails')
      .select('id')
      .lte('scheduled_at', new Date().toISOString())
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
      .limit(100);

    if (error) throw error;
    if (!candidates || candidates.length === 0) {
      return { processed: 0, message: 'No pending emails' };
    }

    // 2. ATOMIC CLAIM: Mark all candidates as 'processing' in one shot to prevent
    //    overlapping cron invocations from grabbing the same emails.
    const candidateIds = candidates.map(e => e.id);
    const { data: claimedRows, error: claimErr } = await supabase
      .from('emails')
      .update({ status: 'processing' })
      .in('id', candidateIds)
      .eq('status', 'pending')
      .select('id');

    if (claimErr) throw claimErr;

    const claimedIds = claimedRows ? claimedRows.map(r => r.id) : [];
    if (claimedIds.length === 0) {
      return { processed: 0, message: 'All candidates claimed by another worker' };
    }

    // 3. Re-fetch the full data for emails we successfully claimed
    const { data: pendingEmails, error: fetchErr } = await supabase
      .from('emails')
      .select('*, campaigns(id, followup_delay_hours, action)')
      .in('id', claimedIds);

    if (fetchErr) throw fetchErr;
    if (!pendingEmails || pendingEmails.length === 0) {
      return { processed: 0, message: 'All candidates claimed by another worker' };
    }

    // 4. Group by user_id to optimize token refreshes
    const userIds = [...new Set(pendingEmails.map(e => e.user_id))];
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('id, refresh_token, email, name')
      .in('id', userIds);
    
    if (userErr) throw userErr;

    // Build a map of user ID -> access token
    const accessTokenMap = {};
    for (const user of users) {
      if (!user.refresh_token) continue;
      try {
        accessTokenMap[user.id] = await refreshAccessToken(user.refresh_token);
      } catch (err) {
        console.error(`Failed to refresh token for user ${user.id}:`, err.message);
      }
    }

    // 5. Process each email sequentially to strictly obey Gmail API rate limits
    let successCount = 0;
    let failCount = 0;

    for (const email of pendingEmails) {
      const accessToken = accessTokenMap[email.user_id];
      const user = users.find(u => u.id === email.user_id);

      if (!accessToken) {
        await markEmailFailed(email.id, 'No valid access token or refresh token expired');
        failCount++;
        continue;
      }

      try {
        // If it's a followup, check for reply first
        if (email.is_followup && email.thread_id) {
          const replied = await checkForReply(accessToken, email.thread_id, user.email);
          if (replied) {
            await supabase.from('emails').update({ status: 'skipped_replied' }).eq('id', email.id);
            continue; // Skip sending
          }
        }

        // Send the email via Gmail API
        const result = await sendEmail(
          accessToken,
          email.to_email,
          email.subject,
          email.body,
          email.thread_id,
          email.rfc_message_id,
          user.name,
          user.email,
          email.cc_email
        );

        // Update email record as sent
        const { error: updateErr } = await supabase.from('emails').update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          thread_id: result.threadId,
          rfc_message_id: result.rfcMessageId || result.id
        }).eq('id', email.id);
        
        if (updateErr) {
          console.error(`Failed to update email ${email.id} after sending:`, updateErr.message);
        }
        successCount++;

        // If this initial email has follow-up data, auto-create follow-up email records
        const hasFollowupData = email.followup_data && (Array.isArray(email.followup_data) || (typeof email.followup_data === 'object' && Array.isArray(email.followup_data.steps)));
        if (!email.is_followup && hasFollowupData) {
          const steps = Array.isArray(email.followup_data) 
            ? email.followup_data 
            : (email.followup_data.steps || []);
          const recipientTz = (typeof email.followup_data === 'object' && email.followup_data.timezone) 
            ? email.followup_data.timezone 
            : 'Asia/Kolkata';

          const followupsToInsert = [];
          for (const step of steps) {
            const stepTz = step.timezone || recipientTz;
            const sendAt = await getUTCFromTimezone(step.dayOffset, step.time, stepTz);

            followupsToInsert.push({
              campaign_id: email.campaign_id,
              user_id: email.user_id,
              to_email: email.to_email,
              cc_email: email.cc_email,
              subject: step.subject || email.subject,
              body: step.body || email.body,
              thread_id: result.threadId,
              rfc_message_id: result.rfcMessageId || result.id,
              scheduled_at: sendAt.toISOString(),
              status: 'pending',
              is_followup: true
            });
          }
          if (followupsToInsert.length > 0) {
            const { error: fuErr } = await supabase.from('emails').insert(followupsToInsert);
            if (fuErr) console.error(`Failed to create follow-ups for email ${email.id}:`, fuErr.message);
          }
        }

        // Rate-Limit padding: Force 500ms delay between consecutive requests matching ~2 sends/sec
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (sendErr) {
        console.error(`Failed to send email ${email.id}:`, sendErr.message);
        await markEmailFailed(email.id, sendErr.message);
        failCount++;
      }
    }

    // 6. Auto-complete campaigns that have no remaining pending/processing emails
    const processedCampaignIds = [...new Set(pendingEmails.map(e => e.campaign_id))];
    for (const campId of processedCampaignIds) {
      try {
        const { count, error: countErr } = await supabase
          .from('emails')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campId)
          .in('status', ['pending', 'processing']);

        if (!countErr && count === 0) {
          await supabase
            .from('campaigns')
            .update({ status: 'completed' })
            .eq('id', campId)
            .eq('status', 'pending');
        }
      } catch (e) {
        console.error(`Failed to check/complete campaign ${campId}:`, e.message);
      }
    }

    return { processed: pendingEmails.length, success: successCount, failed: failCount };
  } catch (err) {
    console.error('Process cron error:', err);
    throw err;
  }
}

async function markEmailFailed(id, errorMsg) {
  await supabase.from('emails').update({ status: 'failed', error: errorMsg }).eq('id', id);
}

module.exports = { processEmailQueue };
