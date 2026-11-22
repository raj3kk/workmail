import {NextResponse} from 'next/server';
import {dbOne} from '@/lib/db';
import {canAccessMailbox, requireUser} from '@/lib/guards';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

// Sender profile — live BIMI DNS check (S1, §15.1).
// GET /api/sender-profile/bimi?mailbox_id=<id>
//
// Server-side ONLY: the BIMI TXT record for the mailbox's domain is read
// live from public DNS (dns.google DoH, the same read pattern as
// app/api/domains/dns/route.ts). No client-side DNS, no cached claim —
// the status comes from the DNS answer on every check, and the raw
// record is returned so the UI can show it verbatim.
//
// Status (RULE 0 — nothing is claimed without the live read):
//   verified    — a record starting v=BIMI1 exists AND its l= tag is a
//                 valid https logo URL.
//   not_set_up  — no TXT record at default._bimi.<domain>.
//   invalid     — a record exists but has no v=BIMI1 tag, or its l= tag
//                 is missing / not an https URL.
//   lookup_failed — the DNS read itself failed (network/DNS error);
//                 the UI must say the check could not run, not guess.
//
// Honesty note (also in docs/BIMI.md and docs/SENDER-AVATAR.md): a
// "verified" record here means the DNS record is valid. Gmail still
// shows NO logo without a paid VMC (~$1,000/yr) + registered trademark.
// Apple Mail, Yahoo and Fastmail can show the logo without a VMC.

async function txt(name: string): Promise<string[]> {
  const r = await fetch(
    'https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=TXT',
    {cache: 'no-store', signal: AbortSignal.timeout(10000)},
  );
  if (!r.ok) throw new Error('DNS lookup failed');
  const j = await r.json();
  return (j.Answer || [])
    .filter((x: any) => x.type === 16)
    .map((x: any) => String(x.data || '').replace(/"/g, '').trim())
    .filter(Boolean);
}

function parseBimi(records: string[]): {status: 'verified' | 'not_set_up' | 'invalid'; logoUrl: string | null} {
  if (records.length === 0) return {status: 'not_set_up', logoUrl: null};
  const bimi = records.find((r) => /^v=bimi1\s*;/i.test(r.trim()));
  if (!bimi) return {status: 'invalid', logoUrl: null};
  const m = bimi.match(/(?:^|;)\s*l=([^;\s]+)/i);
  const logoUrl = m ? m[1].trim() : '';
  if (!/^https:\/\//i.test(logoUrl)) return {status: 'invalid', logoUrl: null};
  try {
    new URL(logoUrl);
  } catch {
    return {status: 'invalid', logoUrl: null};
  }
  return {status: 'verified', logoUrl};
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const limited = await withRateLimit({
    scope: 'write',
    subject: user.id,
    limit: RATE_LIMIT_DEFAULTS.write.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.write.windowSeconds,
  });
  if (limited) return limited;
  const mailboxId = new URL(req.url).searchParams.get('mailbox_id') || '';
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailboxId)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  const box = await dbOne('SELECT id, address FROM mailboxes WHERE id = ?', [mailboxId]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  const address = String(box.address || '');
  const domain = address.split('@')[1]?.toLowerCase() || '';
  if (!domain) return NextResponse.json({error: 'Mailbox has no domain'}, {status: 400});
  const host = 'default._bimi.' + domain;
  let records: string[];
  try {
    records = await txt(host);
  } catch {
    return NextResponse.json({
      mailbox_id: mailboxId,
      address,
      domain,
      host,
      status: 'lookup_failed',
      records: [],
      logo_url: null,
      checked_at: new Date().toISOString(),
      error: 'The BIMI DNS check could not run — try again.',
    });
  }
  const {status, logoUrl} = parseBimi(records);
  return NextResponse.json({
    mailbox_id: mailboxId,
    address,
    domain,
    host,
    status,
    records,
    logo_url: logoUrl,
    checked_at: new Date().toISOString(),
  });
}
