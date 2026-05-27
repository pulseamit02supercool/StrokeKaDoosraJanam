const { supabase } = require('../_lib/supabase');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const cookies = req.headers.cookie || '';
    const strokeToken = cookies.split('; ').find(row => row.startsWith('stroke_token='))?.split('=')[1];
    
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

    const { resolveTimezoneOffset } = require('../_lib/timezone');

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
};
