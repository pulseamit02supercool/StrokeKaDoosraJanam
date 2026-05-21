const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { getOAuthClient } = require('../lib/gmail');
const { supabase } = require('../lib/supabase');

const router = express.Router();

// ── GET /api/auth/login ──
router.get('/login', async (req, res) => {
  try {
    const oAuth2Client = getOAuthClient(req);
    
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline', // Critical: gets a refresh token
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents'
      ],
      prompt: 'consent' // Force consent to guarantee we receive a refresh token
    });
    
    res.redirect(authUrl);
  } catch (err) {
    console.error("Login crash:", err);
    res.status(500).json({ error: "Login crash", message: err.message, stack: err.stack });
  }
});

// ── GET /api/auth/callback ──
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided');
  }

  try {
    const oAuth2Client = getOAuthClient(req);
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Get user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    // Check if user exists in Supabase, else create
    let { data: user, error } = await supabase
      .from('users')
      .select('id, refresh_token')
      .eq('email', userInfo.data.email)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Supabase error:', error);
      return res.status(500).send('Database error');
    }

    let userId;
    const refreshToken = tokens.refresh_token || (user ? user.refresh_token : null);

    if (!user) {
      // New user
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([{
          email: userInfo.data.email,
          name: userInfo.data.name,
          avatar_url: userInfo.data.picture,
          refresh_token: refreshToken
        }])
        .select()
        .single();
        
      if (insertError) throw insertError;
      userId = newUser.id;
    } else {
      // Existing user, update refresh token if we got a new one
      userId = user.id;
      if (tokens.refresh_token) {
        await supabase
          .from('users')
          .update({
            name: userInfo.data.name,
            avatar_url: userInfo.data.picture,
            refresh_token: tokens.refresh_token
          })
          .eq('id', userId);
      }
    }

    // Create session token
    const token = jwt.sign(
      { id: userId, email: userInfo.data.email, name: userInfo.data.name, avatar: userInfo.data.picture },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '7d' }
    );

    // Set cookie
    res.setHeader('Set-Cookie', cookie.serialize('stroke_token', token, {
      httpOnly: false, // allow JS to read it for UI
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/'
    }));

    // Redirect to frontend
    const frontendUrl = process.env.FRONTEND_URL || '';
    if (frontendUrl) {
      res.redirect(`${frontendUrl}?token=${token}`);
    } else {
      res.redirect('/');
    }

  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ error: 'Authentication failed', message: err.message, stack: err.stack, details: err.response?.data || err });
  }
});

module.exports = router;
