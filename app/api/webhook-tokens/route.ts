import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbQuery, dbRun, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, isValidOrigin} from '@/lib/guards';
import {generateWebhookToken, insertWebhookToken} from '@/lib/webhook-tokens';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

export const runtime = 'nodejs';

// Session-authenticated delivery-webhook token management
// (Settings → Webhook tokens; G-01). The plaintext token is returned
// ONLY in the POST create response, once. No GET ever returns a token
// value — only token_prefix, label, last_used_at, created_at,
// expires_at, revoked_at. Create/revoke require workspace owner or
// admin role. Mirrors /api/api-keys (decision D4 shape, separate
// table so the v1 key surface stays clean).
function publicToken(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    label: String(row.label || ''),
    token_prefix: String(row.token_prefix),
    created_by: String(row.created_by),
    last_used_at: row.last_used_at ? String(row.last_used_at) : null,
    expires_at: row.expires_at ? String(row.expires_at) : null,
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    created_at: String(row.created_at),
  };
}

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  label: z.string().trim().min(1).max(100),
  expires_at: z.string().datetime({offset: true}).optional().nullable(),
});

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const rows = await dbQuery(
    'SELECT id, workspace_id, label, token_prefix, created_by, last_used_at, expires_at, revoked_at, created_at FROM webhook_tokens WHERE workspace_id = ? ORDER BY created_at DESC',
    [workspaceId],
  );
  return NextResponse.json({tokens: rows.map(publicToken)});
}

export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
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
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid webhook token request', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const role = await workspaceRole(user.id, d.workspace_id);
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can create webhook tokens.'}, {status: 403});
  if (d.expires_at && d.expires_at <= nowIso())
    return NextResponse.json({error: 'expiry must be in the future.'}, {status: 400});

  const {token, prefix, hash} = generateWebhookToken();
  const id = await insertWebhookToken({
    workspaceId: d.workspace_id,
    label: d.label,
    prefix,
    hash,
    createdBy: user.id,
    expiresAt: d.expires_at || null,
  });
  // The ONLY response that ever carries the plaintext token. Copy it now:
  // it cannot be shown again. Give it to the delivery-event sender
  // (provider webhook forwarder / ops script) as a Bearer token.
  return NextResponse.json({
    id,
    webhook_token: token,
    token_prefix: prefix,
    label: d.label,
    expires_at: d.expires_at || null,
    created_at: nowIso(),
  }, {status: 201});
}

export async function DELETE(req: Request) {
  // Revoke by id, via query (?id=...). Kept on this route (no body on
  // DELETE in some clients).
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({error: 'id required'}, {status: 400});
  return revokeToken(user.id, id);
}

/** Shared revoke: owner/admin of the token's workspace only. */
async function revokeToken(userId: string, id: string) {
  const rows = await dbQuery('SELECT id, workspace_id, revoked_at FROM webhook_tokens WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) return NextResponse.json({error: 'Webhook token not found.'}, {status: 404});
  const role = await workspaceRole(userId, String(row.workspace_id));
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can revoke webhook tokens.'}, {status: 403});
  if (row.revoked_at) return NextResponse.json({revoked: true, already_revoked: true});
  await dbRun('UPDATE webhook_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), id]);
  return NextResponse.json({revoked: true});
}
