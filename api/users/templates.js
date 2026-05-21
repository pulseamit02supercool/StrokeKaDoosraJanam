const { supabase } = require('../_lib/supabase');
const { getOAuthClient } = require('../_lib/gmail');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
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

    const path = req.query.action || req.body.action || '';

    // ── 1. GET ALL TEMPLATES ──
    if (req.method === 'GET' && !req.query.id) {
      const { data, error } = await supabase
        .from('email_templates')
        .select('id, name, doc_url, created_at')
        .eq('user_id', tokenPayload.id)
        .order('created_at', { ascending: false });
        
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    // ── 2. GET (LOAD) INDIVIDUAL TEMPLATE ──
    else if (req.method === 'GET' && req.query.id) {
      const { id } = req.query;

      const { data: tpl, error: fetchErr } = await supabase
        .from('email_templates')
        .select('*')
        .eq('id', id)
        .eq('user_id', tokenPayload.id)
        .single();

      if (fetchErr || !tpl || !tpl.doc_url) {
        return res.status(404).json({ error: 'Template not found or unauthorized' });
      }

      const urlParts = tpl.doc_url.split('/d/');
      if (urlParts.length <= 1) {
        return res.status(400).json({ error: 'Invalid Google Doc URL stored for this template' });
      }
      const documentId = urlParts[1].split('/')[0];

      // Fetch user refresh token
      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('refresh_token')
        .eq('id', tokenPayload.id)
        .single();

      if (userErr || !user || !user.refresh_token) {
        return res.status(400).json({ error: 'OAuth credentials not found. Please log in again.' });
      }

      // Fetch Doc text from Google Docs API
      const oAuth2Client = getOAuthClient(req);
      oAuth2Client.setCredentials({ refresh_token: user.refresh_token });
      const docs = google.docs({ version: 'v1', auth: oAuth2Client });

      const doc = await docs.documents.get({ documentId });
      
      let fullText = '';
      doc.data.body.content.forEach((elem) => {
        if (elem.paragraph) {
          elem.paragraph.elements.forEach((el) => {
            if (el.textRun) {
              fullText += el.textRun.content;
            }
          });
        }
      });

      const parsed = {
        subjectTemplate: '',
        ccTemplate: '',
        bodyTemplate: '',
        followups: []
      };

      const getTagContent = (text, tag) => {
        const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : '';
      };

      parsed.subjectTemplate = getTagContent(fullText, 'SUBJECT');
      parsed.ccTemplate = getTagContent(fullText, 'CC');
      parsed.bodyTemplate = getTagContent(fullText, 'BODY');

      const followupRegex = /\[FOLLOWUP\]([\s\S]*?)\[\/FOLLOWUP\]/gi;
      let match;
      while ((match = followupRegex.exec(fullText)) !== null) {
        const section = match[1];
        const daysMatch = section.match(/Days:\s*(\d+)/i);
        const timeMatch = section.match(/Time:\s*([0-9:]+)/i);
        const bodyMatch = section.match(/Body:\s*\r?\n([\s\S]*)$/i);

        parsed.followups.push({
          dayOffset: daysMatch ? parseInt(daysMatch[1], 10) : 1,
          time: timeMatch ? timeMatch[1].trim() : '10:00',
          bodyTemplate: bodyMatch ? bodyMatch[1].trim() : ''
        });
      }

      return res.status(200).json({
        success: true,
        id: tpl.id,
        name: tpl.name,
        doc_url: tpl.doc_url,
        ...parsed
      });
    }

    // ── 3. SAVE TEMPLATE ──
    else if (req.method === 'POST') {
      const { id, name, subjectTemplate, bodyTemplate, ccTemplate, followups } = req.body;
      if (!name) return res.status(400).json({ error: 'Template name is required' });

      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('refresh_token')
        .eq('id', tokenPayload.id)
        .single();

      if (userErr || !user || !user.refresh_token) {
        return res.status(400).json({ error: 'OAuth credentials not found. Please log in again.' });
      }

      const oAuth2Client = getOAuthClient(req);
      oAuth2Client.setCredentials({ refresh_token: user.refresh_token });
      const docs = google.docs({ version: 'v1', auth: oAuth2Client });

      let docText = `=== STROKE EMAIL OUTREACH TEMPLATE ===\n` +
                    `You can edit the text inside the blocks below. Do not remove the bracketed tags.\n\n` +
                    `[SUBJECT]\n${subjectTemplate || ''}\n[/SUBJECT]\n\n` +
                    `[CC]\n${ccTemplate || ''}\n[/CC]\n\n` +
                    `[BODY]\n${bodyTemplate || ''}\n[/BODY]\n\n`;

      if (Array.isArray(followups) && followups.length > 0) {
        followups.forEach((step) => {
          docText += `[FOLLOWUP]\n` +
                     `Days: ${step.dayOffset || 1}\n` +
                     `Time: ${step.time || '10:00'}\n` +
                     `Body:\n${step.bodyTemplate || ''}\n` +
                     `[/FOLLOWUP]\n\n`;
        });
      }

      let docUrl = '';
      let documentId = '';

      if (id) {
        const { data: existingTpl, error: fetchErr } = await supabase
          .from('email_templates')
          .select('doc_url')
          .eq('id', id)
          .eq('user_id', tokenPayload.id)
          .single();

        if (!fetchErr && existingTpl && existingTpl.doc_url) {
          const urlParts = existingTpl.doc_url.split('/d/');
          if (urlParts.length > 1) {
            documentId = urlParts[1].split('/')[0];
            docUrl = existingTpl.doc_url;
          }
        }
      }

      if (documentId) {
        const doc = await docs.documents.get({ documentId });
        const length = doc.data.body.content[doc.data.body.content.length - 1].endIndex;
        
        const requests = [];
        if (length > 2) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: 1, endIndex: length - 1 }
            }
          });
        }
        requests.push({
          insertText: {
            location: { index: 1 },
            text: docText
          }
        });

        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests }
        });

        const { data, error } = await supabase
          .from('email_templates')
          .update({ name })
          .eq('id', id)
          .eq('user_id', tokenPayload.id)
          .select().single();

        if (error) throw error;
        return res.status(200).json(data);
      } else {
        const doc = await docs.documents.create({
          requestBody: {
            title: `Stroke Template: ${name}`
          }
        });
        documentId = doc.data.documentId;
        docUrl = `https://docs.google.com/document/d/${documentId}/edit`;

        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: { index: 1 },
                  text: docText
                }
              }
            ]
          }
        });

        const { data, error } = await supabase
          .from('email_templates')
          .insert([{
            user_id: tokenPayload.id,
            name,
            doc_url: docUrl
          }])
          .select().single();

        if (error) throw error;
        return res.status(200).json(data);
      }
    }

    // ── 4. DELETE TEMPLATE ──
    else if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing template ID' });

      const { error } = await supabase
        .from('email_templates')
        .delete()
        .eq('id', id)
        .eq('user_id', tokenPayload.id);

      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).send('Method Not Allowed');

  } catch (err) {
    console.error('Serverless templates API error:', err);
    return res.status(500).json({ error: 'Failed to process templates', message: err.message });
  }
};
