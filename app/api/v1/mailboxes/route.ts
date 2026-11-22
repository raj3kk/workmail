import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {authenticateApiKeyWithScope} from '@/lib/api-auth';
import {checkRateLimit, rateLimitResponse, V1_RATE_LIMITS} from '@/lib/rate-limit';

export const runtime = 'nodejs';

// GET /api/v1/mailboxes — integration API (E1, PRODUCTION-PLAN.md §11.1).
// Auth: API key ONLY (Authorization: Bearer wm_live_...), scope
// `messages:read` — the same read scope as GET /api/v1/messages, so
// no new scope is invented. Returns ONLY the key's own workspace
// mailboxes, so an integrator can discover mailbox IDs without
// reading D1 or the UI: [{id, address, display_name}].
// Only active mailboxes are listed, oldest first (the first one is
// the workspace default — the mailbox POST /api/v1/send uses when
// mailbox_id is omitted). No pagination: a workspace has a handful
// of mailboxes. Rate limit reuses the v1_messages window (120/min
// per key) from lib/rate-limit.ts — no second limiter.

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

  const rows = await dbQuery(
    'SELECT id, address, display_name FROM mailboxes WHERE workspace_id = ? AND is_active = 1 ORDER BY created_at ASC',
    [key.workspaceId],
  );
  return NextResponse.json({
    mailboxes: rows.map((r) => ({
      id: String(r.id),
      address: String(r.address),
      display_name: String(r.display_name || ''),
    })),
  });
}
