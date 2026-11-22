import {NextResponse} from 'next/server';
import {dbQuery, dbRun, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';

export const runtime = 'nodejs';

// DELETE /api/api-keys/[id] — revoke an API key (instant; the key
// stops authenticating immediately). Session-authenticated; owner or
// admin of the key's workspace only. The UI confirms with a two-step
// inline confirm, never window.confirm().
export async function DELETE(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const rows = await dbQuery('SELECT id, workspace_id, revoked_at FROM api_keys WHERE id = ?', [params.id]);
  const row = rows[0];
  if (!row) return NextResponse.json({error: 'API key not found.'}, {status: 404});
  const role = await workspaceRole(user.id, String(row.workspace_id));
  // P-02: 404 (not 403) on denial — see DELETE /api/api-keys.
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'API key not found.'}, {status: 404});
  if (row.revoked_at) return NextResponse.json({revoked: true, already_revoked: true});
  await dbRun('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [nowIso(), params.id]);
  return NextResponse.json({revoked: true});
}
