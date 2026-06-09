const { supabase } = require('../_lib/supabase');
const jwt = require('jsonwebtoken');
const { getUTCFromTimezone, resolveTimezoneOffset } = require('../_lib/timezone');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // 1. Authenticate user via Stroke JWT cookie
    const cookies = req.headers.cookie || '';
    const strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    
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
};
