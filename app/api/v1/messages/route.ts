import {NextResponse} from 'next/server';
import {dbOne, dbQuery} from '@/lib/db';
import {authenticateApiKeyWithScope} from '@/lib/api-auth';
import {checkRateLimit, rateLimitResponse, V1_RATE_LIMITS} from '@/lib/rate-limit';

export const runtime = 'nodejs';

// GET /api/v1/messages — integration API (Phase 2, decision D4).
// Auth: API key ONLY (Authorization: Bearer wm_live_...), scope
// `messages:read`. Returns ONLY the key's workspace messages.
// Query: ?mailbox_id&limit&cursor&delivery_state&search&include_body
//   - limit clamped 1–100 (default 50).
//   - cursor is an opaque base64 offset into the same ordering
//     (received_at DESC, id DESC); response carries next_cursor or null.
//   - delivery_state filters to one known state; search matches
//     subject/from/to (LIKE, with % and _ escaped).
//   - Bodies (text_body/html_body) are included ONLY with
//     ?include_body=true, and only for the key's own workspace.
// Rows: id, mailbox_id, folder, from, to, subject, delivery_state,
// provider, received_at, created_at (+ bodies when requested).

const DELIVERY_STATES = [
  'received',
  'accepted',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'deferred',
  'bounced',
  'complained',
  'failed',
  'unknown',
];

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null): number {
  if (!raw) return 0;
  try {
    const n = Number(Buffer.from(raw, 'base64url').toString('utf8'));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export async function GET(req: Request) {
  const auth = await authenticateApiKeyWithScope(req, 'messages:read');
  if (!auth.ok) return NextResponse.json({error: auth.error}, {status: auth.status});
  const {auth: key} = auth;

  const rl = await checkRateLimit({
    scope: 'v1_messages',
    subject: key.keyId,
    limit: V1_RATE_LIMITS.v1_messages.limit,
    windowSeconds: V1_RATE_LIMITS.v1_messages.windowSeconds,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  const u = new URL(req.url);
  const mailboxId = u.searchParams.get('mailbox_id');
  const deliveryState = u.searchParams.get('delivery_state');
  const search = u.searchParams.get('search');
  const includeBody = u.searchParams.get('include_body') === 'true';
  const limitRaw = Number(u.searchParams.get('limit') || '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
  const offset = decodeCursor(u.searchParams.get('cursor'));

  if (deliveryState && !DELIVERY_STATES.includes(deliveryState))
    return NextResponse.json({error: 'Unknown delivery_state.'}, {status: 400});

  // An explicit mailbox must belong to this workspace (foreign /
  // nonexistent ids get the same 403, so a probe learns nothing).
  if (mailboxId) {
    const box = await dbOne('SELECT id FROM mailboxes WHERE id = ? AND workspace_id = ?', [
      mailboxId,
      key.workspaceId,
    ]);
    if (!box) return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  }

  const params: unknown[] = [key.workspaceId];
  let where = 'WHERE workspace_id = ?';
  if (mailboxId) {
    where += ' AND mailbox_id = ?';
    params.push(mailboxId);
  }
  if (deliveryState) {
    where += ' AND delivery_state = ?';
    params.push(deliveryState);
  }
  if (search) {
    where += " AND (subject LIKE ? ESCAPE '\\' OR from_email LIKE ? ESCAPE '\\' OR to_email LIKE ? ESCAPE '\\')";
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }

  const totalRows = await dbQuery(`SELECT COUNT(*) AS c FROM messages ${where}`, params);
  const total = Number(totalRows[0]?.c || 0);
  const bodyCols = includeBody ? ', text_body, html_body' : '';
  const rows = await dbQuery(
    `SELECT id, mailbox_id, folder, from_email, to_email, subject, delivery_state, provider, received_at, created_at${bodyCols}
     FROM messages ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const messages = rows.map((r) => {
    const m: Record<string, unknown> = {
      id: String(r.id),
      mailbox_id: String(r.mailbox_id),
      folder: String(r.folder),
      from: String(r.from_email),
      to: String(r.to_email),
      subject: String(r.subject || ''),
      delivery_state: String(r.delivery_state),
      provider: r.provider ? String(r.provider) : null,
      received_at: r.received_at ? String(r.received_at) : null,
      created_at: String(r.created_at),
    };
    if (includeBody) {
      m.text_body = String(r.text_body || '');
      m.html_body = String(r.html_body || '');
    }
    return m;
  });
  const nextOffset = offset + messages.length;
  return NextResponse.json({
    messages,
    total,
    limit,
    next_cursor: nextOffset < total ? encodeCursor(nextOffset) : null,
  });
}
