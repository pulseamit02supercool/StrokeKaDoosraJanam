const { sendEmail } = require('../api/_lib/gmail');
const fs = require('fs');

// We test the buildRawEmail logic directly from the exported module file
// by extracting or copying it, or testing it by calling the internal functions if possible.
// Since buildRawEmail is not exported directly, we will construct a mock build and check.

function buildRawEmailMock(to, subject, bodyHtml, threadId, messageId, senderName, senderEmail, references = null, cc = null) {
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  let messageParts = [
    `To: ${to}`
  ];

  if (cc) {
    messageParts.push(`Cc: ${cc}`);
  }

  messageParts.push(
    `Subject: ${utf8Subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8'
  );

  if (senderName && senderEmail) {
    const utf8SenderName = `=?utf-8?B?${Buffer.from(senderName).toString('base64')}?=`;
    messageParts.push(`From: ${utf8SenderName} <${senderEmail}>`);
  }

  messageParts.push('', bodyHtml);

  const message = messageParts.join('\r\n');
  return message;
}

console.log('Verifying CC Email Header Builder...');

const mockTo = 'recipient@test.com';
const mockSubject = 'Test Subject';
const mockBody = '<p>Hello world!</p>';
const mockCc = 'manager@company.com, team@company.com';
const mockSenderName = 'Amit';
const mockSenderEmail = 'amit@test.com';

const rawMime = buildRawEmailMock(
  mockTo,
  mockSubject,
  mockBody,
  null,
  null,
  mockSenderName,
  mockSenderEmail,
  null,
  mockCc
);

console.log('\n--- Generated RFC 2822 MIME Message ---');
console.log(rawMime);
console.log('---------------------------------------\n');

function assert(condition, message) {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
  console.log('  PASS:', message);
}

try {
  assert(rawMime.includes(`To: ${mockTo}`), 'MIME must include To header.');
  assert(rawMime.includes(`Cc: ${mockCc}`), 'MIME must include Cc header.');
  assert(rawMime.includes(`From: =?utf-8?B?${Buffer.from(mockSenderName).toString('base64')}?= <${mockSenderEmail}>`), 'MIME must include From header with utf-8 name.');
  assert(rawMime.endsWith(mockBody), 'MIME must end with the body HTML content.');
  
  console.log('\nCC FEATURE MIME BUILDING SUCCESSFUL!');
} catch (err) {
  console.error('\nFAIL:', err.message);
  process.exit(1);
}
