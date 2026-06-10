const { supabase } = require('../_lib/supabase');

module.exports = async (req, res) => {
  try {
    const dbUrl = process.env.SUPABASE_URL;
    const dbKeyLength = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.length : 0;
    const jwtSecret = process.env.JWT_SECRET;
    
    // Check connection to campaigns table
    const { data: campaigns, error: campErr } = await supabase
      .from('campaigns')
      .select('id, created_at')
      .limit(10);
      
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('id, status, is_followup')
      .limit(10);

    res.status(200).json({
      supabase_url: dbUrl,
      supabase_key_length: dbKeyLength,
      jwt_secret_configured: !!jwtSecret,
      campaigns_error: campErr ? campErr.message : null,
      campaigns_count: campaigns ? campaigns.length : 0,
      campaigns_sample: campaigns || [],
      emails_error: emailErr ? emailErr.message : null,
      emails_count: emails ? emails.length : 0,
      emails_sample: emails || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
