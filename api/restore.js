const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// Helper to print with colors
function bold(s)  { return `\x1b[1m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s)   { return `\x1b[31m${s}\x1b[0m`; }
function cyan(s)  { return `\x1b[36m${s}\x1b[0m`; }
function dim(s)   { return `\x1b[2m${s}\x1b[0m`; }

console.log(cyan(bold('\n⚡ Stroke CRM - Gmail-to-Supabase Data Recovery Tool\n')));

// 1. Load environment variables from .env.local
const envPath = path.join(__dirname, '../.env.local');
if (!fs.existsSync(envPath)) {
  console.error(red('❌ .env.local file not found in the root directory!'));
  console.error('Please make sure .env.local exists in your workspace root.');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let key = match[1];
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
});

const { SUPABASE_URL, SUPABASE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(red('❌ Missing SUPABASE_URL or SUPABASE_KEY in .env.local'));
  process.exit(1);
}

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(red('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.local'));
  process.exit(1);
}

// 2. Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper to decode base64 Gmail payloads
function decodeGmailBody(payload) {
  if (!payload) return '';
  
  // If the body is directly in this part
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  
  // If it's multipart, recursively parse parts
  if (payload.parts) {
    // Try to find HTML part first, fallback to plaintext
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart) return decodeGmailBody(htmlPart);
    
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart) return decodeGmailBody(textPart);
    
    for (const part of payload.parts) {
      const body = decodeGmailBody(part);
      if (body) return body;
    }
  }
  return '';
}

async function restore() {
  try {
    // 3. Fetch User to get refresh_token
    console.log(dim('Step 1: Connecting to Supabase and retrieving users...'));
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('*');

    if (userErr) {
      console.error(red('❌ Error fetching users from Supabase:'), userErr.message);
      process.exit(1);
    }

    if (!users || users.length === 0) {
      console.log(red('❌ No users found in the `users` table.'));
      console.log('Please log into the Stroke Web Dashboard first so your user account and refresh_token are recreated, then run this script again!');
      process.exit(1);
    }

    const user = users[0];
    console.log(green(`Found active user: ${bold(user.name || user.email)} (ID: ${user.id})`));
    
    if (!user.refresh_token) {
      console.log(red('❌ Re-created user row exists, but does not have a Google `refresh_token` stored yet.'));
      console.log('Please log out of the Stroke dashboard, and log back in (using Google Authentication) to save your refresh token, then run this script again!');
      process.exit(1);
    }

    console.log(dim('Step 2: Authenticating with Gmail API...'));
    const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oAuth2Client.setCredentials({ refresh_token: user.refresh_token });
    
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    // 4. Fetch Sent Emails
    console.log(dim('Step 3: Fetching recent sent emails from your Gmail account...'));
    const sentListRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:me',
      maxResults: 150 // Fetch the last 150 emails sent by this user
    });

    const messages = sentListRes.data.messages || [];
    if (messages.length === 0) {
      console.log(red('No sent emails found in Gmail! Recovery cannot proceed.'));
      process.exit(0);
    }

    console.log(cyan(`Found ${messages.length} total sent messages. Fetching full details for each message...`));
    
    const emailRecords = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msgInfo = messages[i];
      process.stdout.write(dim(`Fetching metadata ${i + 1}/${messages.length}\r`));
      
      try {
        const fullMsg = await gmail.users.messages.get({
          userId: 'me',
          id: msgInfo.id
        });
        
        const headers = fullMsg.data.payload.headers;
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const toHeader = headers.find(h => h.name.toLowerCase() === 'to')?.value || '';
        const ccHeader = headers.find(h => h.name.toLowerCase() === 'cc')?.value || '';
        const messageIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id')?.value || '';
        const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
        
        // Skip message if it is a direct reply we wrote or doesn't look like an outreach template
        const cleanSubject = subjectHeader.replace(/^(Re|Fwd):\s*/i, '').trim();
        const isReply = subjectHeader.match(/^(Re|Fwd):\s*/i);
        
        // Parse email address from "Name <email@address.com>"
        const extractEmail = (str) => {
          const match = str.match(/<([^>]+)>/);
          return match ? match[1].trim().toLowerCase() : str.trim().toLowerCase();
        };

        const toEmail = extractEmail(toHeader);
        if (!toEmail) continue;

        const bodyHtml = decodeGmailBody(fullMsg.data.payload);

        emailRecords.push({
          id: msgInfo.id,
          threadId: msgInfo.threadId,
          toEmail: toEmail,
          ccEmail: ccHeader ? extractEmail(ccHeader) : null,
          subject: subjectHeader,
          cleanSubject: cleanSubject,
          isReply: !!isReply,
          body: bodyHtml,
          messageId: msgInfo.id,
          rfcMessageId: messageIdHeader,
          sentAt: new Date(dateHeader).toISOString()
        });

      } catch (err) {
        console.error(red(`\nError fetching message ID ${msgInfo.id}:`), err.message);
      }
    }
    
    console.log(green(`\nSuccessfully loaded ${emailRecords.length} sent emails from Gmail.`));

    // 5. Group by Subject to reconstruct Campaigns!
    console.log(dim('\nStep 4: Grouping sent emails into Campaigns...'));
    const campaignsMap = {}; // subject -> array of email records
    
    emailRecords.forEach(rec => {
      // Group only initial outreach emails (skip manual follow-up replies to avoid duplicate campaigns)
      if (rec.isReply) return; 
      
      const key = rec.cleanSubject;
      if (!campaignsMap[key]) {
        campaignsMap[key] = [];
      }
      campaignsMap[key].push(rec);
    });

    const campaignsToCreate = Object.keys(campaignsMap);
    console.log(cyan(`Found ${campaignsToCreate.length} distinct initial outreach campaigns to restore:`));
    
    for (const sub of campaignsToCreate) {
      const count = campaignsMap[sub].length;
      console.log(` - Subject: "${bold(sub)}" (${count} recipient(s) sent)`);
    }

    if (campaignsToCreate.length === 0) {
      console.log(red('\n❌ No initial outreach templates could be detected from your sent history.'));
      console.log('Most sent messages might be replies or did not group properly. Restoring aborted.');
      process.exit(0);
    }

    console.log(dim('\nStep 5: Restoring campaigns and emails to Supabase database...'));

    for (const subject of campaignsToCreate) {
      const recs = campaignsMap[subject];
      const earliestEmail = recs.reduce((prev, curr) => new Date(prev.sentAt) < new Date(curr.sentAt) ? prev : curr);
      const latestEmail = recs.reduce((prev, curr) => new Date(prev.sentAt) > new Date(curr.sentAt) ? prev : curr);
      
      // Reconstruct CSV data headers and rows for backfilled campaign record
      const headers = ['Name', 'Email'];
      const csvData = recs.map(r => ['', r.toEmail]);

      console.log(cyan(`\nCreating campaign record for: "${bold(subject)}"...`));
      
      // Insert Campaign
      const { data: campaign, error: campErr } = await supabase
        .from('campaigns')
        .insert([{
          user_id: user.id,
          action: 'bulkSend',
          subject_template: subject,
          body_template: earliestEmail.body,
          csv_data: csvData,
          headers: headers,
          scheduled_at: earliestEmail.sentAt,
          status: 'completed',
          created_at: earliestEmail.sentAt
        }])
        .select()
        .single();

      if (campErr) {
        console.error(red(`❌ Failed to create campaign for "${subject}":`), campErr.message);
        continue;
      }

      console.log(green(`Campaign restored: ${campaign.id}. Now inserting ${recs.length} emails...`));

      // Insert Emails
      const emailsToInsert = recs.map(r => ({
        campaign_id: campaign.id,
        user_id: user.id,
        to_email: r.toEmail,
        cc_email: r.ccEmail,
        subject: r.subject,
        body: r.body,
        thread_id: r.threadId,
        message_id: r.messageId,
        rfc_message_id: r.rfcMessageId,
        scheduled_at: r.sentAt,
        sent_at: r.sentAt,
        status: 'sent',
        is_followup: false
      }));

      // Also grab any threaded replies in Gmail for these thread IDs to reconstruct follow-ups!
      const allThreads = [...new Set(recs.map(r => r.threadId))];
      const followUpEmailsToInsert = [];
      
      for (const tId of allThreads) {
        // Find if this thread contains follow-up emails sent *after* the initial one
        const threadReplies = emailRecords.filter(r => r.threadId === tId && r.isReply);
        threadReplies.forEach(reply => {
          followUpEmailsToInsert.push({
            campaign_id: campaign.id,
            user_id: user.id,
            to_email: reply.toEmail,
            cc_email: reply.ccEmail,
            subject: reply.subject,
            body: reply.body,
            thread_id: reply.threadId,
            message_id: reply.messageId,
            rfc_message_id: reply.rfcMessageId,
            scheduled_at: reply.sentAt,
            sent_at: reply.sentAt,
            status: 'sent',
            is_followup: true
          });
        });
      }

      const allEmailsToInsert = [...emailsToInsert, ...followUpEmailsToInsert];

      const { error: emailsErr } = await supabase
        .from('emails')
        .insert(allEmailsToInsert);

      if (emailsErr) {
        console.error(red(`❌ Failed to restore emails for campaign ${campaign.id}:`), emailsErr.message);
      } else {
        console.log(green(`Successfully restored ${emailsToInsert.length} initial emails and ${followUpEmailsToInsert.length} threaded follow-ups!`));
      }
    }

    console.log(bold(green('\n🎉 SUCCESS: Data recovery complete! Check your Stroke Web Dashboard.')));

  } catch (err) {
    console.error(red('\n❌ Critical Error in Recovery script:'), err);
  }
}

restore();
