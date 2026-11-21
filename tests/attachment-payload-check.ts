// Local verification for the outbound-attachment slice (no network, no
// real send): renders one provider request payload fragment per provider
// from a fake 1 KB attachment and verifies base64 round-trips and the
// filename is preserved. Uses the real builders from lib/providers.ts.
// Run: node --import ./tests/register-alias.mjs tests/attachment-payload-check.ts
import {randomBytes} from 'node:crypto';
import {
  buildResendAttachments,
  buildMailjetAttachments,
  buildBrevoAttachments,
  buildSendpulseAttachmentsBinary,
  type SendAttachment,
} from '../lib/providers';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const original = randomBytes(1024); // fake 1 KB file
const att: SendAttachment = {
  filename: 'invoice-2026.pdf',
  contentType: 'application/pdf',
  sizeBytes: original.length,
  base64: original.toString('base64'),
  objectKey: 'att/ws-test/mb-test/uuid-invoice-2026.pdf',
};

// Resend: attachments: [{filename, content (base64), content_type}]
const resend = buildResendAttachments([att]);
check('resend: one attachment', resend.length === 1);
check('resend: filename preserved', resend[0]?.filename === att.filename);
check('resend: content_type preserved', resend[0]?.content_type === 'application/pdf');
check(
  'resend: base64 round-trips',
  Buffer.from(resend[0]?.content || '', 'base64').equals(original),
);

// Mailjet: Attachments: [{ContentType, Filename, Base64Content}]
const mailjet = buildMailjetAttachments([att]);
check('mailjet: one attachment', mailjet.length === 1);
check('mailjet: Filename preserved', mailjet[0]?.Filename === att.filename);
check('mailjet: ContentType preserved', mailjet[0]?.ContentType === 'application/pdf');
check(
  'mailjet: base64 round-trips',
  Buffer.from(mailjet[0]?.Base64Content || '', 'base64').equals(original),
);

// Brevo: attachment: [{name, content (base64)}]
const brevo = buildBrevoAttachments([att]);
check('brevo: one attachment', brevo.length === 1);
check('brevo: name preserved', brevo[0]?.name === att.filename);
check(
  'brevo: base64 round-trips',
  Buffer.from(brevo[0]?.content || '', 'base64').equals(original),
);

// SendPulse: attachments_binary: {<filename>: <base64>}
const sp = buildSendpulseAttachmentsBinary([att]);
check(
  'sendpulse: filename key present',
  Object.keys(sp).length === 1 && sp['invoice-2026.pdf'] !== undefined,
);
check(
  'sendpulse: base64 round-trips',
  Buffer.from(sp['invoice-2026.pdf'] || '', 'base64').equals(original),
);

// Empty list stays empty (no-attachment payloads unchanged).
check('empty: resend []', buildResendAttachments([]).length === 0);
check('empty: mailjet []', buildMailjetAttachments([]).length === 0);
check('empty: brevo []', buildBrevoAttachments([]).length === 0);
check('empty: sendpulse {}', Object.keys(buildSendpulseAttachmentsBinary([])).length === 0);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll attachment payload checks passed (no network, no real send).');
