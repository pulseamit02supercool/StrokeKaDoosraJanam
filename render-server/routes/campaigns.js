const express = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/gmail');
const { supabase } = require('../lib/supabase');
const { getUTCFromIST } = require('../lib/timezone');

const router = express.Router();

// ── POST /api/campaigns/create ──
router.post('/create', async (req, res) => {
  try {
    // 1. Authenticate user via Stroke JWT cookie
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const { action, subjectTemplate, bodyTemplate, ccTemplate, csvData, headers, scheduledAt, followupDelayHours, followups } = req.body;

    // 2. Validate input
    if (!csvData || !Array.isArray(csvData) || csvData.length === 0) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }

    // 2.a Validate scheduled time is not in the past
    if (scheduledAt) {
      const schedDate = new Date(scheduledAt);
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
      if (schedDate < twoMinAgo) {
        return res.status(400).json({ error: 'Scheduled time is in the past. Please pick a future date/time.' });
      }
    }

    // 2.b Validate total 7-day duration rule
    const maxFollowupDayOffset = Array.isArray(followups) && followups.length > 0
      ? Math.max(...followups.map(step => Number(step.dayOffset || 0)))
      : 0;

    const startMs = scheduledAt ? new Date(scheduledAt).getTime() : Date.now();
    const endMs = startMs + (maxFollowupDayOffset * 24 * 60 * 60 * 1000);
    const maxAllowedEndMs = Date.now() + (7 * 24 * 60 * 60 * 1000);

    if (endMs > maxAllowedEndMs) {
      return res.status(400).json({ error: 'Campaign total timeframe (schedule delay + max follow-up day offset) cannot exceed 7 days from today.' });
    }

    const emailHeaderIdx = headers.findIndex(h => h.toLowerCase().includes('email'));
    if (emailHeaderIdx === -1) return res.status(400).json({ error: 'No Email column found' });
    if (action === 'threadedFollowup') {
      const hasThreadCol = headers.some(h => String(h).toLowerCase().includes('threadid'));
      if (!hasThreadCol) return res.status(400).json({ error: "Follow-up CSV must include 'threadId' column from send log." });
    }

    // 3. Create Campaign Record
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .insert([{
        user_id: user.id,
        action,
        subject_template: subjectTemplate,
        body_template: bodyTemplate,
        cc_template: ccTemplate || null,
        csv_data: csvData,
        headers,
        scheduled_at: scheduledAt || new Date().toISOString(),
        followup_delay_hours: followupDelayHours || null,
        followup_config: (Array.isArray(followups) && followups.length > 0) ? followups : null,
        status: 'pending' // we will mark it done once processed
      }])
      .select()
      .single();

    if (campErr) throw campErr;

    const resolveTemplate = (tpl, row) => {
      let out = tpl || '';
      headers.forEach((header, i) => {
        const val = row[i] || '';
        const regex = new RegExp(`{{\\s*${header}\\s*}}`, 'gi');
        out = out.replace(regex, val);
      });
      return out;
    };

    const normalizeBody = (body) => {
      if (!body) return '';
      const hasHtml = /<\/?[a-z][\s\S]*>/i.test(body);
      if (hasHtml) {
        return body.replace(/\r\n/g, '\n');
      }
      return body
        .replace(/\n/g, '<br/>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    };

    // 4. Create Individual Email Records (Batched insert)
    const emailsToInsert = [];
    const seenEmails = new Set(); // Deduplicate: prevent same address from being queued twice
    const threadIdx = headers.findIndex(h => String(h).toLowerCase().includes('threadid'));
    const rfcIdx = headers.findIndex(h => String(h).toLowerCase().includes('rfcmessageid'));
    const now = new Date();

    for (const row of csvData) {
      const toEmail = (row[emailHeaderIdx] || '').trim().toLowerCase();
      if (!toEmail) continue;
      if (seenEmails.has(toEmail)) continue; // Skip duplicate addresses within same campaign
      seenEmails.add(toEmail);

      const resolvedCc = ccTemplate ? resolveTemplate(ccTemplate, row).trim() : '';

      // Threaded follow-up mode: create multiple follow-ups with custom templates.
      if (action === 'threadedFollowup') {
        let threadId = threadIdx !== -1 ? (row[threadIdx] || '').trim() : '';
        let rfcMessageId = rfcIdx !== -1 ? (row[rfcIdx] || '').trim() : '';
        
        // Defensively strip quotes if any remain
        threadId = threadId.replace(/^["']|["']$/g, '');
        rfcMessageId = rfcMessageId.replace(/^["']|["']$/g, '');
        
        // If user accidentally pasted a full Gmail URL, extract just the ID
        if (threadId.includes('mail.google.com') || threadId.includes('/')) {
          threadId = threadId.split('/').pop().split('?')[0].split('#').pop().trim();
        }

        if (!threadId) continue;

        const followupSteps = Array.isArray(followups) && followups.length ? followups : [{
          dayOffset: 0,
          time: null,
          subjectTemplate: subjectTemplate || 'Follow up',
          bodyTemplate: bodyTemplate || ''
        }];

        for (let stepIdx = 0; stepIdx < followupSteps.length; stepIdx++) {
          const step = followupSteps[stepIdx] || {};
          const stepBodyTemplate = step.bodyTemplate || bodyTemplate || '';
          const resolvedSubject = resolveTemplate(subjectTemplate || 'Follow up', row);
          const resolvedBody = normalizeBody(resolveTemplate(stepBodyTemplate, row));

          let sendAt;
          if (step.isImplicit) {
            sendAt = scheduledAt ? new Date(scheduledAt) : new Date();
          } else {
            sendAt = getUTCFromIST(step.dayOffset, step.time);
          }

          emailsToInsert.push({
            campaign_id: campaign.id,
            user_id: user.id,
            to_email: toEmail,
            cc_email: resolvedCc || null,
            subject: resolvedSubject,
            body: resolvedBody,
            thread_id: threadId,
            rfc_message_id: rfcMessageId,
            scheduled_at: sendAt.toISOString(),
            status: 'pending',
            is_followup: true
          });
        }
        continue;
      }

      // Bulk send mode: one immediate/scheduled email per row.
      const resolvedSubject = resolveTemplate(subjectTemplate, row);
      const resolvedBody = normalizeBody(resolveTemplate(bodyTemplate, row));

      // Pre-resolve follow-up templates per row if followups are configured
      let followupData = null;
      if (Array.isArray(followups) && followups.length > 0) {
        followupData = followups.map(step => ({
          dayOffset: Number(step.dayOffset || 0),
          time: step.time || '10:00',
          body: normalizeBody(resolveTemplate(step.bodyTemplate || bodyTemplate || '', row))
        }));
      }

      emailsToInsert.push({
        campaign_id: campaign.id,
        user_id: user.id,
        to_email: toEmail,
        cc_email: resolvedCc || null,
        subject: resolvedSubject,
        body: resolvedBody,
        scheduled_at: campaign.scheduled_at,
        status: 'pending',
        is_followup: false,
        followup_data: followupData
      });
    }

    const { error: emailsErr } = await supabase
      .from('emails')
      .insert(emailsToInsert);

    if (emailsErr) throw emailsErr;

    res.status(200).json({ success: true, campaignId: campaign.id, count: emailsToInsert.length });

  } catch (err) {
    console.error('Create campaign error:', err);
    res.status(500).json({ error: 'Failed to schedule campaign' });
  }
});

// ── GET /api/campaigns/list ──
router.get('/list', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    // Fetch campaigns
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, action, scheduled_at, status, created_at, followup_delay_hours, subject_template, body_template, followup_config')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!campaigns || campaigns.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch email stats for these campaigns
    const { data: emails, error: emailsErr } = await supabase
      .from('emails')
      .select('campaign_id, status')
      .in('campaign_id', campaigns.map(c => c.id));

    if (emailsErr) throw emailsErr;

    // Attach stats to campaigns
    const enriched = campaigns.map(c => {
      const campEmails = (emails || []).filter(e => e.campaign_id === c.id);
      return {
        ...c,
        total_emails: campEmails.length,
        sent: campEmails.filter(e => e.status === 'sent').length,
        pending: campEmails.filter(e => e.status === 'pending' || e.status === 'processing').length,
        paused: campEmails.filter(e => e.status === 'paused').length,
        failed: campEmails.filter(e => e.status === 'failed').length,
        skipped: campEmails.filter(e => e.status === 'skipped_replied').length,
        cancelled: campEmails.filter(e => e.status === 'cancelled').length
      };
    });

    res.status(200).json(enriched);

  } catch (err) {
    console.error('List campaigns error:', err);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// ── POST /api/campaigns/update ──
router.post('/update', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const { campaignId, subjectTemplate, bodyTemplate, ccTemplate } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // 1. Fetch Campaign to verify ownership and get csv_data
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) {
      return res.status(404).json({ error: 'Campaign not found or unauthorized' });
    }

    if (!campaign.csv_data || !campaign.headers) {
      return res.status(400).json({ error: 'Cannot edit this campaign. The original data might have been cleaned up.' });
    }

    // 2. Fetch pending emails for this campaign
    const { data: pendingEmails, error: emailsErr } = await supabase
      .from('emails')
      .select('id, to_email, is_followup, scheduled_at, status')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending');

    if (emailsErr) throw emailsErr;

    // Helper functions for re-templating
    const resolveTemplate = (tpl, row) => {
      let out = tpl || '';
      campaign.headers.forEach((header, i) => {
        const val = row[i] || '';
        const regex = new RegExp(`{{\\s*${header}\\s*}}`, 'gi');
        out = out.replace(regex, val);
      });
      return out;
    };
    
    const normalizeBody = (body) => {
      if (!body) return '';
      const hasHtml = /<\/?[a-z][\s\S]*>/i.test(body);
      if (hasHtml) {
        return body.replace(/\r\n/g, '\n');
      }
      return body
        .replace(/\n/g, '<br/>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    };

    const emailHeaderIdx = campaign.headers.findIndex(h => h.toLowerCase().includes('email'));
    const followupsArr = req.body.followups || [];

    // Group pending emails by to_email to safely remap already-spawned follow-ups
    const emailsByUser = {};
    for (const email of pendingEmails) {
       if (!emailsByUser[email.to_email]) emailsByUser[email.to_email] = { main: null, fup: [] };
       if (!email.is_followup) emailsByUser[email.to_email].main = email;
       else emailsByUser[email.to_email].fup.push(email);
    }

    // 3. Prepare updates for pending main emails
    const emailUpdates = [];
    for (const to_email of Object.keys(emailsByUser)) {
      const row = campaign.csv_data.find(r => (r[emailHeaderIdx] || '').trim() === to_email);
      if (!row) continue;

      const group = emailsByUser[to_email];

      // Update the main email (if it is still pending)
      if (group.main) {
         const resolvedSubject = resolveTemplate(subjectTemplate, row);
         const resolvedBody = normalizeBody(resolveTemplate(bodyTemplate, row));
         const resolvedCc = ccTemplate ? resolveTemplate(ccTemplate, row).trim() : '';
         
         let newFollowupData = null;
         if (followupsArr.length > 0) {
            newFollowupData = followupsArr.map(step => ({
              dayOffset: Number(step.dayOffset || 0),
              time: step.time || '10:00',
              body: normalizeBody(resolveTemplate(step.bodyTemplate || '', row))
            }));
         }
         
         emailUpdates.push({
            id: group.main.id,
            subject: resolvedSubject,
            body: resolvedBody,
            cc_email: resolvedCc || null,
            followup_data: newFollowupData,
            status: group.main.status
         });
      }

      // Update already-spawned follow-up emails (if they are pending)
      if (group.fup.length > 0 && followupsArr.length > 0) {
         // Sort pending followups functionally by their scheduled time
         group.fup.sort((a,b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
         
         // The number of pending followups corresponds strictly to the last N items in the config array
         const numPending = group.fup.length;
         const templatesToApply = followupsArr.slice(-numPending); 
         
         for (let i = 0; i < group.fup.length; i++) {
            const fuEmail = group.fup[i];
            const tpl = templatesToApply[i] || followupsArr[0]; // fallback
            
            const resolvedBody = normalizeBody(resolveTemplate(tpl.bodyTemplate || bodyTemplate, row));
            const subTpl = tpl.subjectTemplate || subjectTemplate || 'Follow up';
            const resolvedSubject = resolveTemplate(subTpl, row);
            const resolvedCc = ccTemplate ? resolveTemplate(ccTemplate, row).trim() : '';

            emailUpdates.push({
               id: fuEmail.id,
               subject: resolvedSubject,
               body: resolvedBody,
               cc_email: resolvedCc || null
            });
         }
      }
    }

    // Update emails one by one
    for (const update of emailUpdates) {
       const emailUpdateObj = { subject: update.subject, body: update.body };
       if (update.followup_data !== undefined) {
         emailUpdateObj.followup_data = update.followup_data;
       }
       if (update.cc_email !== undefined) {
         emailUpdateObj.cc_email = update.cc_email;
       }
       await supabase.from('emails').update(emailUpdateObj).eq('id', update.id);
    }

    // 4. Update Campaign Record
    const campUpdateObj = {
       subject_template: subjectTemplate,
       body_template: bodyTemplate,
       cc_template: ccTemplate || null
    };
    if (followupsArr.length > 0) campUpdateObj.followup_config = followupsArr;
    
    await supabase.from('campaigns').update(campUpdateObj).eq('id', campaignId);

    res.status(200).json({ success: true, updatedEmails: emailUpdates.length });

  } catch (err) {
    console.error('Update campaign error:', err);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// ── POST /api/campaigns/delete ──
router.post('/delete', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // 1. Fetch Campaign to verify ownership
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) {
      return res.status(404).json({ error: 'Campaign not found or unauthorized' });
    }

    // 2. Delete all pending emails for this campaign
    const { error: emailsErr } = await supabase
      .from('emails')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('status', 'pending');

    if (emailsErr) throw emailsErr;

    // 3. Mark Campaign Record as cancelled
    await supabase.from('campaigns').update({
       status: 'cancelled'
    }).eq('id', campaignId);

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Delete campaign error:', err);
    res.status(500).json({ error: 'Failed to cancel campaign' });
  }
});

// ── GET /api/campaigns/export ──
router.get('/export', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const campaignId = req.query.campaignId;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // Fetch the campaign to make sure it belongs to the user
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('id, action')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch emails for this campaign
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('to_email, subject, status, scheduled_at, sent_at, thread_id, rfc_message_id, is_followup, error')
      .eq('campaign_id', campaign.id)
      .order('scheduled_at', { ascending: true });

    if (emailErr) throw emailErr;

    // Build CSV
    const keys = ['toEmail', 'subject', 'status', 'scheduledAt', 'sentAt', 'threadId', 'rfcMessageId', 'isFollowup', 'error'];
    
    const csvRows = [keys.join(',')]; // Header
    
    for (const email of emails) {
      const row = [
        email.to_email,
        email.subject,
        email.status,
        email.scheduled_at || '',
        email.sent_at || '',
        email.thread_id || '',
        email.rfc_message_id || '',
        email.is_followup ? 'Yes' : 'No',
        email.error || ''
      ];
      
      const escapedRow = row.map(cell => {
        const str = String(cell || '');
        return `"${str.replace(/"/g, '""')}"`;
      });
      csvRows.push(escapedRow.join(','));
    }

    const csvContent = csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="campaign_${campaignId}_log.csv"`);
    res.status(200).send(csvContent);

  } catch (err) {
    console.error('Export campaign error:', err);
    res.status(500).json({ error: 'Failed to export campaign' });
  }
});

// ── GET /api/campaigns/emails ──
router.get('/emails', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });

    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const campaignId = req.query.campaignId;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // Verify campaign belongs to the user
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) {
      return res.status(404).json({ error: 'Campaign not found or unauthorized' });
    }

    // Fetch individual emails
    const { data: emails, error: emailsErr } = await supabase
      .from('emails')
      .select('id, to_email, subject, status, scheduled_at, sent_at, is_followup, error')
      .eq('campaign_id', campaignId)
      .order('scheduled_at', { ascending: true });

    if (emailsErr) throw emailsErr;

    res.status(200).json(emails || []);
  } catch (err) {
    console.error('Fetch campaign emails error:', err);
    res.status(500).json({ error: 'Failed to fetch campaign emails' });
  }
});

// ── POST /api/campaigns/emails/update-status ──
router.post('/emails/update-status', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });

    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    const { emailId, status } = req.body;
    if (!emailId || !status) return res.status(400).json({ error: 'Missing emailId or status' });

    const allowedStatuses = ['pending', 'paused', 'cancelled'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be pending, paused, or cancelled.' });
    }

    // Fetch the email first to get the campaign_id
    const { data: email, error: emailErr } = await supabase
      .from('emails')
      .select('id, campaign_id, status')
      .eq('id', emailId)
      .single();

    if (emailErr || !email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Verify campaign belongs to the user
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', email.campaign_id)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) {
      return res.status(403).json({ error: 'Unauthorized access to this email' });
    }

    // Perform status update
    const { data: updatedEmail, error: updateErr } = await supabase
      .from('emails')
      .update({ status })
      .eq('id', emailId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.status(200).json({ success: true, email: updatedEmail });
  } catch (err) {
    console.error('Update email status error:', err);
    res.status(500).json({ error: 'Failed to update email status' });
  }
});

// ── POST /api/campaigns/backup ──
router.post('/backup', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });

    const tokenPayload = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!tokenPayload || !tokenPayload.id) return res.status(401).json({ error: 'Invalid token' });

    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // Verify campaign ownership and fetch
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('user_id', tokenPayload.id)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch associated emails
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('scheduled_at', { ascending: true });

    if (emailErr) throw emailErr;

    // Fetch user refresh token
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('refresh_token')
      .eq('id', tokenPayload.id)
      .single();

    if (userErr || !user || !user.refresh_token) {
      return res.status(400).json({ error: 'OAuth credentials not found. Please log in again.' });
    }

    // Connect to Google Sheets API
    const oAuth2Client = getOAuthClient(req);
    oAuth2Client.setCredentials({ refresh_token: user.refresh_token });
    const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });

    // Create Spreadsheet
    const dateStr = new Date(campaign.created_at).toLocaleDateString();
    const spreadsheet = await sheets.spreadsheets.create({
      resource: {
        properties: {
          title: `Stroke Backup: ${campaign.subject_template || 'Campaign'} (${dateStr})`
        }
      }
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;
    const spreadsheetUrl = spreadsheet.data.spreadsheetUrl;

    // Build data rows
    const headerRow = ['To Email', 'Subject', 'Status', 'Is Followup', 'Scheduled At', 'Sent At', 'Thread ID', 'Error Logs'];
    const emailRows = (emails || []).map(e => [
      e.to_email || '',
      e.subject || '',
      e.status || '',
      e.is_followup ? 'Yes' : 'No',
      e.scheduled_at ? new Date(e.scheduled_at).toLocaleString() : '',
      e.sent_at ? new Date(e.sent_at).toLocaleString() : '',
      e.thread_id || '',
      e.error || ''
    ]);

    const values = [
      ['STROKE CRM CAMPAIGN BACKUP SUMMARY'],
      ['Campaign ID', campaign.id],
      ['Subject Template', campaign.subject_template || 'N/A'],
      ['Created At', new Date(campaign.created_at).toLocaleString()],
      [],
      ['RECIPIENT SEND LOGS'],
      headerRow,
      ...emailRows
    ];

    // Append to sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      resource: { values }
    });

    res.status(200).json({ success: true, url: spreadsheetUrl, id: spreadsheetId });

  } catch (err) {
    console.error('Google Sheet backup error:', err);
    res.status(500).json({ error: 'Failed to create Google Sheet backup', details: err.message });
  }
});

// ── POST /api/campaigns/backup-doc ──
router.post('/backup-doc', async (req, res) => {
  try {
    let strokeToken = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      strokeToken = authHeader.split(' ')[1];
    } else {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    }
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });

    const tokenPayload = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!tokenPayload || !tokenPayload.id) return res.status(401).json({ error: 'Invalid token' });

    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

    // Verify campaign ownership and fetch
    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('user_id', tokenPayload.id)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch associated emails
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('scheduled_at', { ascending: true });

    if (emailErr) throw emailErr;

    // Fetch user refresh token
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('refresh_token')
      .eq('id', tokenPayload.id)
      .single();

    if (userErr || !user || !user.refresh_token) {
      return res.status(400).json({ error: 'OAuth credentials not found. Please log in again.' });
    }

    // Connect to Google Docs API
    const oAuth2Client = getOAuthClient(req);
    oAuth2Client.setCredentials({ refresh_token: user.refresh_token });
    const docs = google.docs({ version: 'v1', auth: oAuth2Client });

    // Create Document
    const dateStr = new Date(campaign.created_at).toLocaleDateString();
    const docTitle = `Stroke Campaign Outline: ${campaign.subject_template || 'Campaign'} (${dateStr})`;
    const document = await docs.documents.create({
      requestBody: {
        title: docTitle
      }
    });

    const documentId = document.data.documentId;
    const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;

    // Construct text outline
    let bodyText = `STROKE CRM CAMPAIGN OUTLINE & HISTORY\n` +
                   `===================================\n` +
                   `Campaign ID: ${campaign.id}\n` +
                   `Subject Template: ${campaign.subject_template || 'N/A'}\n` +
                   `Created At: ${new Date(campaign.created_at).toLocaleString()}\n` +
                   `Status: ${campaign.status}\n\n` +
                   `CAMPAIGN BODY TEMPLATE\n` +
                   `----------------------\n` +
                   `${campaign.body_template || 'N/A'}\n\n`;

    if (campaign.followup_config && Array.isArray(campaign.followup_config) && campaign.followup_config.length > 0) {
      bodyText += `FOLLOW-UP SEQUENCE CONFIGURATION\n` +
                  `-------------------------------\n`;
      campaign.followup_config.forEach((step, idx) => {
        bodyText += `Step ${idx + 1}: Send after ${step.dayOffset || 1} day(s) at ${step.time || '10:00'}\n` +
                    `Body:\n${step.bodyTemplate || ''}\n` +
                    `-------------------------------\n`;
      });
      bodyText += `\n`;
    }

    bodyText += `RECIPIENT SEND LOGS & OUTLINE\n` +
                `-----------------------------\n`;

    if (!emails || emails.length === 0) {
      bodyText += `No emails sent or scheduled for this campaign.\n`;
    } else {
      emails.forEach((e, idx) => {
        bodyText += `[${idx + 1}] Recipient: ${e.to_email}\n` +
                    `    Subject: ${e.subject || 'N/A'}\n` +
                    `    Status: ${e.status || 'pending'}\n` +
                    `    Is Follow-up: ${e.is_followup ? 'Yes' : 'No'}\n` +
                    `    Scheduled At: ${e.scheduled_at ? new Date(e.scheduled_at).toLocaleString() : 'N/A'}\n` +
                    `    Sent At: ${e.sent_at ? new Date(e.sent_at).toLocaleString() : 'N/A'}\n` +
                    `    Thread ID: ${e.thread_id || 'N/A'}\n`;
        if (e.error) {
          bodyText += `    Error Logs: ${e.error}\n`;
        }
        bodyText += `\n`;
      });
    }

    // Insert text into the Google Doc
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: bodyText
            }
          }
        ]
      }
    });

    res.status(200).json({ success: true, url: docUrl, id: documentId });

  } catch (err) {
    console.error('Google Doc backup error:', err);
    res.status(500).json({ error: 'Failed to create Google Doc backup', details: err.message });
  }
});

module.exports = router;
