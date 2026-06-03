const { supabase } = require('../../render-server/lib/supabase');
const jwt = require('jsonwebtoken');

module.exports = exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
};
