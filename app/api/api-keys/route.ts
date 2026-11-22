import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbQuery, dbRun, jparse, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {API_SCOPES, generateApiKey, insertApiKey, type ApiScope} from '@/lib/api-auth';

export const runtime = 'nodejs';

// Session-authenticated API-key management (Settings → API keys).
// The plaintext key is returned ONLY in the POST create response, once.
// No GET ever returns a key value — only key_prefix, label, scopes,
// last_used_at, created_at, expires_at, revoked_at.
// Create/revoke require workspace owner or admin role.

// Public shape of a key row (never includes the hash or the key).
function publicKey(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    label: String(row.label || ''),
    key_prefix: String(row.key_prefix),
    scopes: jparse<ApiScope[]>(String(row.scopes || '[]'), []),
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
  scopes: z.array(z.enum(['send', 'messages:read'] as const)).min(1).max(API_SCOPES.length),
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
    'SELECT id, workspace_id, label, key_prefix, scopes, created_by, last_used_at, expires_at, revoked_at, created_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC',
    [workspaceId],
  );
  return NextResponse.json({keys: rows.map(publicKey)});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid API key request', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const role = await workspaceRole(user.id, d.workspace_id);
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can create API keys.'}, {status: 403});
  if (d.expires_at && d.expires_at <= nowIso())
    return NextResponse.json({error: 'expiry must be in the future.'}, {status: 400});

  const {key, prefix, hash} = generateApiKey();
  const id = await insertApiKey({
    workspaceId: d.workspace_id,
    label: d.label,
    prefix,
    hash,
    scopes: d.scopes as ApiScope[],
    createdBy: user.id,
    expiresAt: d.expires_at || null,
  });
  // The ONLY response that ever carries the plaintext key. Copy it now:
  // it cannot be shown again.
  return NextResponse.json({
    id,
    api_key: key,
    key_prefix: prefix,
    label: d.label,
    scopes: d.scopes,
    expires_at: d.expires_at || null,
    created_at: nowIso(),
  }, {status: 201});
}

export async function DELETE(req: Request) {
  // Revoke by id, via query (?id=...). Kept on this route (no body on
  // DELETE in some clients) — the [id] route does the same thing.
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({error: 'id required'}, {status: 400});
  return revokeKey(user.id, id);
}

/** Shared revoke: owner/admin of the key's workspace only. */
async function revokeKey(userId: string, id: string) {
  const rows = await dbQuery('SELECT id, workspace_id, revoked_at FROM api_keys WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) return NextResponse.json({error: 'API key not found.'}, {status: 404});
  const role = await workspaceRole(userId, String(row.workspace_id));
  // P-02: 404 (not 403) on denial, so a cross-tenant key-id probe
  // cannot confirm another tenant's API key exists by the status code.
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'API key not found.'}, {status: 404});
  if (row.revoked_at) return NextResponse.json({revoked: true, already_revoked: true});
  await dbRun('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [nowIso(), id]);
  return NextResponse.json({revoked: true});
}
