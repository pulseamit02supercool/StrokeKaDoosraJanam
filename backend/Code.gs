/**
 * Stroke - CRM Outreach Backend
 * Google Apps Script Web App
 *
 * SETUP:
 *  1. Paste this into script.google.com
 *  2. Enable Advanced Service: Gmail API (sidebar > Services > + > Gmail API)
 *  3. Deploy as Web App (Execute as: Me, Access: Anyone)
 */

/* ──────────────────────────────────────────────
   CONFIGURATION
   ────────────────────────────────────────────── */
// Retrieve BACKEND_API_URL dynamically from Script Properties, falling back to a hardcoded URL.
var BACKEND_API_URL = getBackendUrl();

function getBackendUrl() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty('BACKEND_API_URL');
    if (url) {
      return url.replace(/\/$/, ''); // Remove trailing slash
    }
  } catch (err) {
    Logger.log("Error reading BACKEND_API_URL property: " + err.toString());
  }
  return 'https://stroke-25mz.onrender.com'; // Hardcoded fallback
}

/* ──────────────────────────────────────────────
   Web App Entry Points
   ────────────────────────────────────────────── */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    var result;

    switch (action) {
      case 'bulkSend':
        result = handleBulkSend(data);
        break;
      case 'threadedFollowup':
        result = handleThreadedFollowup(data);
        break;
      case 'checkReplies':
        result = handleCheckReplies(data);
        break;
      case 'preview':
        result = handlePreview(data);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', message: 'Stroke API is running.' })
  ).setMimeType(ContentService.MimeType.JSON);
}

/* ──────────────────────────────────────────────
   Variable Engine – case-insensitive replacement
   ────────────────────────────────────────────── */

function replaceVariables(template, headers, row) {
  var result = template;
  for (var i = 0; i < headers.length; i++) {
    var pattern = new RegExp('\\{\\{\\s*' + escapeRegex(headers[i].trim()) + '\\s*\\}\\}', 'gi');
    result = result.replace(pattern, (row[i] || '').trim());
  }
  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ──────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────── */

function findColumnIndex(headers, fragment) {
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].trim().toLowerCase().indexOf(fragment.toLowerCase()) !== -1) {
      return i;
    }
  }
  return -1;
}

function getRfcMessageId(googleMsgId) {
  try {
    var msg = Gmail.Users.Messages.get('me', googleMsgId, {
      format: 'metadata',
      metadataHeaders: ['Message-ID']
    });
    var hdrs = msg.payload.headers;
    for (var i = 0; i < hdrs.length; i++) {
      if (hdrs[i].name.toLowerCase() === 'message-id') return hdrs[i].value;
    }
  } catch (_) {}
  return '';
}

/* ──────────────────────────────────────────────
   Feature 0 – Preview (resolve variables for first N rows)
   ────────────────────────────────────────────── */

function handlePreview(data) {
  var parsed = Utilities.parseCsv(data.csvData);
  if (parsed.length < 2) throw new Error('CSV needs a header row + at least one data row.');

  var headers = parsed[0];
  var previewCount = Math.min(data.previewCount || 3, parsed.length - 1);
  var previews = [];

  for (var r = 1; r <= previewCount; r++) {
    previews.push({
      subject: replaceVariables(data.subjectTemplate || '', headers, parsed[r]),
      body: replaceVariables(data.bodyTemplate || '', headers, parsed[r]),
      row: parsed[r]
    });
  }

  return { success: true, headers: headers, previews: previews, totalRows: parsed.length - 1 };
}

/* ──────────────────────────────────────────────
   Feature 1 – Bulk Send (initial blast)
   ────────────────────────────────────────────── */

function handleBulkSend(data) {
  var parsed = Utilities.parseCsv(data.csvData);
  if (parsed.length < 2) throw new Error('CSV needs a header row + at least one data row.');

  var headers = parsed[0];
  var emailIdx = findColumnIndex(headers, 'email');
  if (emailIdx === -1) throw new Error("CSV must contain an 'email' column.");

  // Sender configuration
  var senderEmail = (data.senderEmail || '').trim();
  var senderName  = (data.senderName  || '').trim();

  var logs = [];

  for (var r = 1; r < parsed.length; r++) {
    var row = parsed[r];
    var to = (row[emailIdx] || '').trim();
    if (!to) continue;

    var subject = replaceVariables(data.subjectTemplate || '', headers, row);
    var body = replaceVariables(data.bodyTemplate || '', headers, row);

    try {
      // Build send options
      var opts = { htmlBody: body };
      if (senderEmail) opts.from = senderEmail;   // Gmail "Send As" alias
      if (senderName)  opts.name = senderName;

      // Send via GmailApp (draft + send pattern for reliable id retrieval)
      var draft = GmailApp.createDraft(to, subject, '', opts);
      var sent = draft.send();

      Utilities.sleep(500);

      var msgId = sent.getId();
      var threadId = sent.getThread().getId();
      var rfcId = getRfcMessageId(msgId);

      logs.push({
        email: to,
        subject: subject,
        threadId: threadId,
        messageId: msgId,
        rfcMessageId: rfcId,
        sentFrom: senderEmail || Session.getActiveUser().getEmail(),
        status: 'sent'
      });
    } catch (err) {
      logs.push({ email: to, status: 'error', error: err.toString() });
    }
  }

  return { success: true, action: 'bulkSend', logs: logs };
}

/* ──────────────────────────────────────────────
   Feature 2 – Threaded Follow-ups
   Uses Advanced Gmail Service to inject In-Reply-To / References headers
   ────────────────────────────────────────────── */

function handleThreadedFollowup(data) {
  var parsed = Utilities.parseCsv(data.csvData);
  if (parsed.length < 2) throw new Error('CSV needs header + data rows.');

  var headers = parsed[0];
  var emailIdx    = findColumnIndex(headers, 'email');
  var threadIdx   = findColumnIndex(headers, 'threadid');
  var rfcIdx      = findColumnIndex(headers, 'rfcmessageid');
  var subjectIdx  = findColumnIndex(headers, 'subject');

  if (emailIdx === -1 || threadIdx === -1)
    throw new Error("Follow-up CSV must have 'email' and 'threadId' columns.");

  var logs = [];

  for (var r = 1; r < parsed.length; r++) {
    var row = parsed[r];
    var to       = (row[emailIdx]   || '').trim();
    var threadId = (row[threadIdx]  || '').trim();
    var rfcRef   = rfcIdx !== -1 ? (row[rfcIdx] || '').trim() : '';
    var subject  = subjectIdx !== -1 ? (row[subjectIdx] || '').trim() : 'Follow up';
    if (!to || !threadId) continue;

    // ── Feature 3 inline: Auto-stop if replied ──
    if (hasRecipientReplied(threadId)) {
      logs.push({ email: to, threadId: threadId, status: 'skipped_replied' });
      continue;
    }

    var body = replaceVariables(data.bodyTemplate || '', headers, row);

    // Sender configuration
    var senderEmail = (data.senderEmail || '').trim();
    var senderName  = (data.senderName  || '').trim();
    var fromHeader  = senderEmail
      ? (senderName ? senderName + ' <' + senderEmail + '>' : senderEmail)
      : '';

    // Fetch the live thread to get the correct subject and build a proper References chain
    var finalSubject = subject;
    var inReplyTo = rfcRef;
    var references = rfcRef;
    try {
      var threadData = Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: ['Subject', 'Message-ID', 'References'] });
      var msgs = threadData.messages || [];
      if (msgs.length > 0) {
        // Use the original thread subject (first message) to avoid double "Re:" prefixing
        var firstMsgHeaders = msgs[0].payload.headers || [];
        for (var h = 0; h < firstMsgHeaders.length; h++) {
          if (firstMsgHeaders[h].name.toLowerCase() === 'subject') {
            var origSubject = firstMsgHeaders[h].value;
            if (!origSubject.toLowerCase().startsWith('re:')) {
              finalSubject = 'Re: ' + origSubject;
            } else {
              finalSubject = origSubject;
            }
            break;
          }
        }
        // Reply to the latest message and build the full References chain
        var lastMsgHeaders = msgs[msgs.length - 1].payload.headers || [];
        for (var h = 0; h < lastMsgHeaders.length; h++) {
          var hName = lastMsgHeaders[h].name.toLowerCase();
          if (hName === 'message-id') {
            inReplyTo = lastMsgHeaders[h].value;
          } else if (hName === 'references') {
            references = lastMsgHeaders[h].value;
          }
        }
        // Append the latest Message-ID to the chain if not already present
        if (inReplyTo && references.indexOf(inReplyTo) === -1) {
          references = (references + ' ' + inReplyTo).trim();
        }
      }
    } catch (fetchErr) {
      Logger.log('Failed to fetch thread details for ' + threadId + ': ' + fetchErr.toString());
    }

    // Build RFC 2822 raw message
    var rawParts = [];
    if (fromHeader) rawParts.push('From: ' + fromHeader);
    rawParts.push(
      'To: ' + to,
      'Subject: ' + finalSubject,
      'In-Reply-To: ' + inReplyTo,
      'References: ' + references,
      'Content-Type: text/html; charset=UTF-8',
      'MIME-Version: 1.0',
      '',
      body
    );
    var raw = rawParts.join('\r\n');

    var encoded = Utilities.base64EncodeWebSafe(raw);

    try {
      var resp = Gmail.Users.Messages.send(
        { raw: encoded, threadId: threadId },
        'me'
      );
      logs.push({ email: to, threadId: threadId, newMessageId: resp.id, status: 'followed_up' });
    } catch (err) {
      logs.push({ email: to, threadId: threadId, status: 'error', error: err.toString() });
    }
  }

  return { success: true, action: 'threadedFollowup', logs: logs };
}

/* ──────────────────────────────────────────────
   Feature 3 – Reply Detection
   ────────────────────────────────────────────── */

function handleCheckReplies(data) {
  var threadIds = data.threadIds || [];
  var results = {};
  for (var i = 0; i < threadIds.length; i++) {
    results[threadIds[i]] = hasRecipientReplied(threadIds[i]);
  }
  return { success: true, action: 'checkReplies', replies: results };
}

function hasRecipientReplied(threadId) {
  var threads = GmailApp.search('rfc822msgid:' + threadId + ' OR in:anywhere thread:' + threadId);
  // Fallback: retrieve thread directly
  try {
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) return false;
    var messages = thread.getMessages();
    if (messages.length <= 1) return false;

    var myEmail = Session.getActiveUser().getEmail().toLowerCase();
    var aliases = GmailApp.getAliases().map(function(email) { return email.toLowerCase(); });

    for (var i = 1; i < messages.length; i++) {
      var from = messages[i].getFrom().toLowerCase();
      var isFromMe = (from.indexOf(myEmail) !== -1);
      if (!isFromMe) {
        for (var j = 0; j < aliases.length; j++) {
          if (from.indexOf(aliases[j]) !== -1) {
            isFromMe = true;
            break;
          }
        }
      }
      if (isFromMe) continue; // Sent by user or one of their aliases
      return true; // Someone else replied
    }
  } catch (_) {}
  return false;
}

/* ──────────────────────────────────────────────
   Feature 4 – Vercel/Render Cron Trigger & Utilities
   ────────────────────────────────────────────── */

function triggerRenderCron() {
  try {
    var backendUrl = getBackendUrl();
    var headers = {};
    
    // Check if CRON_SECRET is set in script properties
    var cronSecret = PropertiesService.getScriptProperties().getProperty('CRON_SECRET');
    if (cronSecret) {
      headers["Authorization"] = "Bearer " + cronSecret;
    }
    
    Logger.log("Pinging backend cron: " + backendUrl + "/api/cron/process");
    
    var response = UrlFetchApp.fetch(backendUrl + "/api/cron/process", {
      method: "get",
      headers: headers,
      muteHttpExceptions: true
    });
    
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();
    
    Logger.log("Render Ping Response Code: " + responseCode);
    Logger.log("Render Ping Response Body: " + responseText);
    
    if (responseCode !== 200) {
      Logger.log("WARNING: Cron ping did not return HTTP 200. Got: " + responseCode);
    }
  } catch (e) {
    Logger.log("Error pinging cron: " + e.toString());
  }
}

/**
 * Sets up a time-driven trigger to run `triggerRenderCron` every minute.
 * Run this function once from the Apps Script editor to initialize the cron job automatically.
 */
function setupCronTrigger() {
  // Clear any existing triggers for triggerRenderCron first to prevent duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'triggerRenderCron') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  
  // Create a new time-driven trigger running every 1 minute
  ScriptApp.newTrigger('triggerRenderCron')
    .timeBased()
    .everyMinutes(1)
    .create();
    
  Logger.log("✅ Successfully created time-driven trigger to run triggerRenderCron every minute.");
}

/**
 * Diagnostic Helper: Checks current configurations, triggers, and runs a test ping.
 * Run this in the Apps Script Editor to debug backend connectivity!
 */
function testBackendConnection() {
  Logger.log("--- Starting Stroke Backend Cron Diagnostic ---");
  
  var backendUrl = getBackendUrl();
  Logger.log("Configured BACKEND_API_URL: " + backendUrl);
  
  var cronSecret = PropertiesService.getScriptProperties().getProperty('CRON_SECRET');
  Logger.log("CRON_SECRET is " + (cronSecret ? "SET (length: " + cronSecret.length + ")" : "NOT SET"));
  
  var triggers = ScriptApp.getProjectTriggers();
  var triggerFound = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'triggerRenderCron') {
      triggerFound = true;
      Logger.log("Found Active Trigger: triggerRenderCron (" + triggers[i].getTriggerSource() + ")");
    }
  }
  if (!triggerFound) {
    Logger.log("❌ WARNING: No time-driven trigger found for triggerRenderCron! The cron will NOT run automatically.");
    Logger.log("👉 Please run the `setupCronTrigger` function once in this editor to set it up.");
  } else {
    Logger.log("✅ Trigger is active!");
  }
  
  Logger.log("Testing ping to backend...");
  triggerRenderCron();
  Logger.log("--- Diagnostic Complete ---");
}
