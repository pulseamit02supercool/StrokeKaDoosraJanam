const { supabase } = require('../_lib/supabase');
const jwt = require('jsonwebtoken');
const { getUTCFromTimezone } = require('../_lib/timezone');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const cookies = req.headers.cookie || '';
    const strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    
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
            
            // Recalculate scheduled_at using parent's sent_at (if parent was sent) or current time
            let newScheduledAt = fuEmail.scheduled_at;
            if (tpl.dayOffset !== undefined && tpl.time !== undefined) {
               const baseDate = (group.main && group.main.sent_at) ? group.main.sent_at : null;
               const recipientTz = (group.main && group.main.followup_data && group.main.followup_data.timezone) ? group.main.followup_data.timezone : 'Asia/Kolkata';
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
};
