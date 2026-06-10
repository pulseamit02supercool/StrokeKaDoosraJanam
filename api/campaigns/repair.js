const { supabase } = require('../_lib/supabase');
const jwt = require('jsonwebtoken');
const { getUTCFromTimezone } = require('../_lib/timezone');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    let strokeToken = req.cookies?.stroke_token;
    if (!strokeToken) {
      const cookies = req.headers.cookie || '';
      strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
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
};
