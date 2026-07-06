const express = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { getOAuthClient } = require('../lib/gmail');
const { supabase } = require('../lib/supabase');
const { getUTCFromTimezone, resolveTimezoneOffset } = require('../lib/timezone');

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

    const { action, subjectTemplate, bodyTemplate, ccTemplate, csvData, headers, scheduledAt, followupDelayHours, followups, timezoneMode, timezoneColumn, timezoneMappings } = req.body;

    // 2. Validate input
    if (!csvData || !Array.isArray(csvData) || csvData.length === 0) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }

    // 2.a Validate scheduled time is not in the past
    if (scheduledAt) {
      if (timezoneMode === 'recipient') {
        const dateMatch = scheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (dateMatch) {
          const y = Number(dateMatch[1]);
          const m = Number(dateMatch[2]) - 1;
          const d = Number(dateMatch[3]);
          
          const nowServer = new Date();
          const todayServer = new Date(nowServer.getFullYear(), nowServer.getMonth(), nowServer.getDate());
          const scheduledDay = new Date(y, m, d);
          
          if (scheduledDay < todayServer) {
            return res.status(400).json({ error: 'Scheduled date cannot be in the past. Please pick today or a future date.' });
          }
        }
      } else {
        const schedDate = new Date(scheduledAt);
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
        if (schedDate < twoMinAgo) {
          return res.status(400).json({ error: 'Scheduled time is in the past. Please pick a future date/time.' });
        }
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
      out = out.replace(/<span[^>]*class=["']email-var["'][^>]*>(.*?)<\/span>/gi, '$1');
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

    const locationColIdx = (timezoneMode === 'recipient' && timezoneColumn) ? headers.indexOf(timezoneColumn) : -1;

    for (const row of csvData) {
      const toEmail = (row[emailHeaderIdx] || '').trim().toLowerCase();
      if (!toEmail) continue;
      if (seenEmails.has(toEmail)) continue; // Skip duplicate addresses within same campaign
      seenEmails.add(toEmail);

      const resolvedCc = ccTemplate ? resolveTemplate(ccTemplate, row).trim() : '';

      // Extract raw location and resolve recipient timezone
      const rawLocation = locationColIdx !== -1 ? (row[locationColIdx] || '').trim() : '';
      let recipientTz = 'Asia/Kolkata'; // Fallback standard IST route
      if (timezoneMode === 'recipient' && rawLocation) {
        if (timezoneMappings && timezoneMappings[rawLocation] && timezoneMappings[rawLocation] !== 'Google Maps API Resolution') {
          recipientTz = timezoneMappings[rawLocation];
        } else {
          recipientTz = rawLocation;
        }
      }

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
            // Initial email in recipient local timezone
            if (timezoneMode === 'recipient' && scheduledAt) {
              const match = scheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
              if (match) {
                const y = Number(match[1]);
                const m = Number(match[2]) - 1;
                const d = Number(match[3]);
                const hh = Number(match[4]);
                const mm = Number(match[5]);
                
                const wallClockUTC = new Date(Date.UTC(y, m, d, hh, mm, 0, 0));
                const offsetMinutes = await resolveTimezoneOffset(recipientTz, wallClockUTC);
                
                if (hh === 11 && mm === 0) {
                  const recipientNow = new Date(now.getTime() + offsetMinutes * 60000);
                  const localSeconds = recipientNow.getUTCHours() * 3600 + recipientNow.getUTCMinutes() * 60 + recipientNow.getUTCSeconds();
                  if (localSeconds > 11 * 3600) {
                    wallClockUTC.setUTCDate(wallClockUTC.getUTCDate() + 1);
                  }
                }
                
                sendAt = new Date(wallClockUTC.getTime() - offsetMinutes * 60000);
                
                if (sendAt <= now) {
                  sendAt = new Date(now.getTime() + 60 * 1000);
                }
              } else {
                sendAt = new Date(scheduledAt);
              }
            } else {
              sendAt = scheduledAt ? new Date(scheduledAt) : new Date();
            }
          } else {
            // Follow-up step calculated dynamically in recipient local timezone
            sendAt = await getUTCFromTimezone(step.dayOffset, step.time, recipientTz);
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
          timezone: recipientTz, // Store resolved timezone on each step
          body: normalizeBody(resolveTemplate(step.bodyTemplate || bodyTemplate || '', row))
        }));
      }

      let sendAt;
      if (timezoneMode === 'recipient' && scheduledAt) {
        const match = scheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (match) {
          const y = Number(match[1]);
          const m = Number(match[2]) - 1;
          const d = Number(match[3]);
          const hh = Number(match[4]);
          const mm = Number(match[5]);
          
          const wallClockUTC = new Date(Date.UTC(y, m, d, hh, mm, 0, 0));
          const offsetMinutes = await resolveTimezoneOffset(recipientTz, wallClockUTC);
          
          if (hh === 11 && mm === 0) {
            const recipientNow = new Date(now.getTime() + offsetMinutes * 60000);
            const localSeconds = recipientNow.getUTCHours() * 3600 + recipientNow.getUTCMinutes() * 60 + recipientNow.getUTCSeconds();
            if (localSeconds > 11 * 3600) {
              wallClockUTC.setUTCDate(wallClockUTC.getUTCDate() + 1);
            }
          }
          
          sendAt = new Date(wallClockUTC.getTime() - offsetMinutes * 60000);
          
          if (sendAt <= now) {
            sendAt = new Date(now.getTime() + 60 * 1000);
          }
        } else {
          sendAt = new Date(scheduledAt);
        }
      } else {
        sendAt = new Date(campaign.scheduled_at);
      }

      // Safe metadata wrapper to hold resolved timezone and steps array in existing JSON column
      const finalFollowupData = {
        timezone: recipientTz,
        steps: followupData || []
      };

      emailsToInsert.push({
        campaign_id: campaign.id,
        user_id: user.id,
        to_email: toEmail,
        cc_email: resolvedCc || null,
        subject: resolvedSubject,
        body: resolvedBody,
        scheduled_at: sendAt.toISOString(),
        status: 'pending',
        is_followup: false,
        followup_data: finalFollowupData
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

    // 2. Fetch all emails for this campaign to get parent sent_at dates
    const { data: allEmails, error: emailsErr } = await supabase
      .from('emails')
      .select('id, to_email, is_followup, scheduled_at, status, sent_at, followup_data')
      .eq('campaign_id', campaignId);

    if (emailsErr) throw emailsErr;

    const pendingEmails = allEmails.filter(e => e.status === 'pending');

    // Helper functions for re-templating
    const resolveTemplate = (tpl, row) => {
      let out = tpl || '';
      out = out.replace(/<span[^>]*class=["']email-var["'][^>]*>(.*?)<\/span>/gi, '$1');
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

    // Group all emails by to_email to safely remap already-spawned follow-ups
    const emailsByUser = {};
    for (const email of allEmails) {
       if (!emailsByUser[email.to_email]) emailsByUser[email.to_email] = { main: null, fup: [] };
       if (!email.is_followup) {
           emailsByUser[email.to_email].main = email;
       } else if (email.status === 'pending') {
           emailsByUser[email.to_email].fup.push(email);
       }
    }

    // 3. Prepare updates for pending main emails
    const emailUpdates = [];
    for (const to_email of Object.keys(emailsByUser)) {
      const row = campaign.csv_data.find(r => (r[emailHeaderIdx] || '').trim() === to_email);
      if (!row) continue;

      const group = emailsByUser[to_email];

      // Update the main email (if it is still pending)
      if (group.main && group.main.status === 'pending') {
         const resolvedSubject = resolveTemplate(subjectTemplate, row);
         const resolvedBody = normalizeBody(resolveTemplate(bodyTemplate, row));
         const resolvedCc = ccTemplate ? resolveTemplate(ccTemplate, row).trim() : '';
         
         let newFollowupData = null;
         if (followupsArr.length > 0) {
            const oldFupData = group.main && group.main.followup_data;
            const recipientTz = (oldFupData && typeof oldFupData === 'object' && !Array.isArray(oldFupData) && oldFupData.timezone)
               ? oldFupData.timezone
               : 'Asia/Kolkata';

            newFollowupData = {
               timezone: recipientTz,
               steps: followupsArr.map(step => ({
                 dayOffset: Number(step.dayOffset || 0),
                 time: step.time || '10:00',
                 timezone: recipientTz,
                 body: normalizeBody(resolveTemplate(step.bodyTemplate || '', row))
               }))
            };
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
            
            // Recalculate scheduled_at using parent's sent_at (if parent was sent) or current time
            let newScheduledAt = fuEmail.scheduled_at;
            if (tpl.dayOffset !== undefined && tpl.time !== undefined) {
               const baseDate = (group.main && group.main.sent_at) ? group.main.sent_at : null;
               const oldFupData = group.main && group.main.followup_data;
               const recipientTz = (oldFupData && typeof oldFupData === 'object' && !Array.isArray(oldFupData) && oldFupData.timezone)
                  ? oldFupData.timezone
                  : 'Asia/Kolkata';
               const sendAt = await getUTCFromTimezone(tpl.dayOffset, tpl.time, recipientTz, baseDate);
               newScheduledAt = sendAt.toISOString();
            }

            emailUpdates.push({
               id: fuEmail.id,
               subject: resolvedSubject,
               body: resolvedBody,
               cc_email: resolvedCc || null,
               scheduled_at: newScheduledAt
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
       if (update.scheduled_at !== undefined) {
         emailUpdateObj.scheduled_at = update.scheduled_at;
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

// ── POST /api/campaigns/repair ──
router.post('/repair', async (req, res) => {
  try {
    let strokeToken = req.cookies?.stroke_token;
    if (!strokeToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        strokeToken = authHeader.split(' ')[1];
      } else {
        const cookies = req.headers.cookie || '';
        strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
      }
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    // 1. Fetch all sent main emails for this user
    const { data: sentMains, error: fetchErr } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_followup', false)
      .eq('status', 'sent');

    if (fetchErr) throw fetchErr;

    let totalSpawned = 0;
    const followupsToInsert = [];

    for (const email of sentMains) {
      const hasFollowupData = email.followup_data && (Array.isArray(email.followup_data) || (typeof email.followup_data === 'object' && Array.isArray(email.followup_data.steps)));
      if (!hasFollowupData) continue;

      // Check if followups already exist for this email/recipient
      const { data: existingFups, error: fupErr } = await supabase
        .from('emails')
        .select('id')
        .eq('campaign_id', email.campaign_id)
        .eq('to_email', email.to_email)
        .eq('is_followup', true);

      if (fupErr) throw fupErr;

      // If follow-ups already exist, do not duplicate
      if (existingFups && existingFups.length > 0) continue;

      const steps = Array.isArray(email.followup_data)
        ? email.followup_data
        : (email.followup_data.steps || []);
      const recipientTz = (typeof email.followup_data === 'object' && email.followup_data.timezone)
        ? email.followup_data.timezone
        : 'Asia/Kolkata';

      for (const step of steps) {
        const stepTz = step.timezone || recipientTz;
        // Calculate sendAt relative to parent email's sent_at timestamp!
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
        totalSpawned++;
      }
    }

    if (followupsToInsert.length > 0) {
      const { error: insertErr } = await supabase.from('emails').insert(followupsToInsert);
      if (insertErr) throw insertErr;
    }

    res.status(200).json({ success: true, spawned: totalSpawned });

  } catch (err) {
    console.error('Repair campaign followups error:', err);
    res.status(500).json({ error: 'Failed to repair campaign followups', details: err.message });
  }
});

// ── POST /api/campaigns/recover-skipped ──
router.post('/recover-skipped', async (req, res) => {
  try {
    let strokeToken = req.cookies?.stroke_token;
    if (!strokeToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        strokeToken = authHeader.split(' ')[1];
      } else {
        const cookies = req.headers.cookie || '';
        strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
      }
    }
    
    if (!strokeToken) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = jwt.verify(strokeToken, process.env.JWT_SECRET || 'fallback-secret');
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid token' });

    // Update status from 'skipped_replied' back to 'pending' for this user
    const { data: updated, error } = await supabase
      .from('emails')
      .update({ status: 'pending', error: null })
      .eq('user_id', user.id)
      .eq('status', 'skipped_replied')
      .select('id');

    if (error) throw error;

    res.status(200).json({ success: true, recoveredCount: updated ? updated.length : 0 });
  } catch (err) {
    console.error('Recover skipped emails error:', err);
    res.status(500).json({ error: 'Failed to recover skipped emails', details: err.message });
  }
});

// ── GET /api/campaigns/diagnostic ──
router.get('/diagnostic', async (req, res) => {
  try {
    const dbUrl = process.env.SUPABASE_URL;
    const dbKeyLength = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.length : 0;
    const jwtSecret = process.env.JWT_SECRET;

    // Decode token if present
    let loggedInUserId = null;
    let strokeToken = req.cookies?.stroke_token;
    if (!strokeToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        strokeToken = authHeader.split(' ')[1];
      } else {
        const cookies = req.headers.cookie || '';
        strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
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

    // All not-yet-sent emails with their scheduled times, to debug "mails didn't go" reports
    const { data: pendingAll } = await supabase
      .from('emails')
      .select('id, campaign_id, user_id, to_email, status, is_followup, scheduled_at, created_at, error')
      .in('status', ['pending', 'processing', 'failed'])
      .order('scheduled_at', { ascending: true })
      .limit(100);

    // Map user ids to account emails so campaigns can be attributed
    const { data: usersMap } = await supabase
      .from('users')
      .select('id, email');

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

    // Map samples to avoid large bodies/HTML causing truncation
    const miniEmailsSample = (emails || []).map(e => ({
      id: e.id,
      campaign_id: e.campaign_id,
      user_id: e.user_id,
      status: e.status,
      is_followup: e.is_followup,
      to_email: e.to_email,
      sent_at: e.sent_at
    }));

    res.status(200).json({
      supabase_url: dbUrl,
      supabase_key_length: dbKeyLength,
      jwt_secret_configured: !!jwtSecret,
      logged_in_user_id: loggedInUserId,
      last_cron_run: global.lastCronRun || null,
      server_time_utc: new Date().toISOString(),
      pending_emails_all: pendingAll || [],
      users_map: usersMap || [],
      dipsik_emails: dipsikEmails || [],
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
      emails_sample: miniEmailsSample
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      .select('id, action, csv_data, headers')
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

    // Find headers index
    const headersArr = campaign.headers || [];
    const emailHeaderIdx = headersArr.findIndex(h => h.toLowerCase().includes('email'));
    const locationColIdx = headersArr.findIndex(h => {
      const clean = h.trim().toLowerCase();
      return clean.includes('location') || clean.includes('timezone') || clean.includes('tz') || clean.includes('country') || clean.includes('city');
    });

    const { resolveTimezoneOffset } = require('../lib/timezone');

    // Build CSV
    const keys = ['toEmail', 'subject', 'status', 'scheduledAt', 'sentAt', 'threadId', 'rfcMessageId', 'isFollowup', 'resolvedTimezone', 'error'];
    
    const csvRows = [keys.join(',')]; // Header
    
    for (const email of emails) {
      let resolvedTz = 'Asia/Kolkata (IST standard)';
      if (campaign.csv_data && emailHeaderIdx !== -1) {
        const matchingRow = campaign.csv_data.find(r => (r[emailHeaderIdx] || '').trim().toLowerCase() === email.to_email.trim().toLowerCase());
        if (matchingRow && locationColIdx !== -1) {
          const rawLoc = (matchingRow[locationColIdx] || '').trim();
          if (rawLoc) {
            const offsetMins = await resolveTimezoneOffset(rawLoc);
            const sign = offsetMins >= 0 ? '+' : '-';
            const abs = Math.abs(offsetMins);
            const hh = String(Math.floor(abs / 60)).padStart(2, '0');
            const mm = String(abs % 60).padStart(2, '0');
            resolvedTz = `${rawLoc} (UTC${sign}${hh}:${mm})`;
          }
        }
      }

      const row = [
        email.to_email,
        email.subject,
        email.status,
        email.scheduled_at || '',
        email.sent_at || '',
        email.thread_id || '',
        email.rfc_message_id || '',
        email.is_followup ? 'Yes' : 'No',
        resolvedTz,
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

// ── GET /api/campaigns/preview ──
router.get('/preview', async (req, res) => {
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

    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select('csv_data, headers')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!campaign.csv_data || campaign.csv_data.length === 0) {
       return res.status(200).json({ headers: campaign.headers || [], row: [] });
    }

    res.status(200).json({ headers: campaign.headers || [], row: campaign.csv_data[0] || [] });
  } catch (err) {
    console.error('Preview campaign error:', err);
    res.status(500).json({ error: 'Failed to fetch preview data' });
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

// ── POST /api/campaigns/emails/update-content ──
router.post('/emails/update-content', async (req, res) => {
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

    const { emailId, subject, body } = req.body;
    if (!emailId || subject === undefined || body === undefined) {
      return res.status(400).json({ error: 'Missing emailId, subject, or body' });
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

    if (email.status !== 'pending' && email.status !== 'paused') {
      return res.status(400).json({ error: 'Cannot edit an email that is already sent or cancelled.' });
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

    // Perform content update
    const cleanBody = body ? body.replace(/<span[^>]*class=["']email-var["'][^>]*>(.*?)<\/span>/gi, '$1') : body;
    const { data: updatedEmail, error: updateErr } = await supabase
      .from('emails')
      .update({ subject, body: cleanBody })
      .eq('id', emailId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.status(200).json({ success: true, email: updatedEmail });
  } catch (err) {
    console.error('Update email content error:', err);
    res.status(500).json({ error: 'Failed to update email content' });
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
