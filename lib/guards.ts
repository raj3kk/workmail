import {NextResponse} from 'next/server';
import {dbOne, dbQuery} from '@/lib/db';
import {getSessionUser, type SessionUser} from '@/lib/auth';

// Central auth guard (D1 + session cookies).
// Returns {user, response}: if response is non-null, return it immediately.
// Checks, in order: valid session -> user not suspended -> none of the user's
// workspaces suspended -> MFA (if enrolled, session must be MFA-verified;
// if MFA_ENFORCEMENT=true and the user never enrolled, setup is required).
export async function requireUser(req: Request): Promise<{user: SessionUser | null; session: any | null; response: NextResponse | null}> {
  const {user, session} = await getSessionUser(req);
  if (!user || !session) {
    return {user: null, session: null, response: NextResponse.json({error: 'Unauthorized'}, {status: 401})};
  }
  if (user.suspended_at) {
    return {user: null, session: null, response: NextResponse.json({error: 'Account suspended'}, {status: 403})};
  }
  const suspendedWs = await dbOne(
    'SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.suspended_at IS NOT NULL LIMIT 1',
    [user.id]);
  if (suspendedWs) {
    return {user: null, session: null, response: NextResponse.json({error: 'Workspace suspended'}, {status: 403})};
  }
  if (user.mfa_secret && !session.mfa_verified) {
    return {user: null, session: null, response: NextResponse.json({error: 'MFA verification required', code: 'MFA_REQUIRED'}, {status: 403})};
  }
  if (!user.mfa_secret && process.env.MFA_ENFORCEMENT === 'true') {
    return {user: null, session: null, response: NextResponse.json({error: 'MFA enrollment required', code: 'MFA_SETUP_REQUIRED'}, {status: 403})};
  }
  return {user, session, response: null};
}

export async function requirePlatformAdmin(userId: string): Promise<boolean> {
  const row = await dbOne('SELECT user_id FROM platform_admins WHERE user_id = ?', [userId]);
  return !!row;
}

// Workspace role check. Returns the role string or null.
export async function workspaceRole(userId: string, workspaceId: string): Promise<string | null> {
  const row = await dbOne('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
  return row ? String(row.role) : null;
}

export async function requireWorkspaceRole(userId: string, workspaceId: string, roles: string[]): Promise<string | null> {
  const role = await workspaceRole(userId, workspaceId);
  return role && roles.includes(role) ? role : null;
}

// Mailbox access: owner role on the workspace, or an explicit mailbox_members row.
export async function canAccessMailbox(userId: string, mailboxId: string, write = false): Promise<boolean> {
  const box = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ? AND is_active = 1', [mailboxId]);
  if (!box) return false;
  const role = await workspaceRole(userId, String(box.workspace_id));
  if (role === 'owner') return true;
  if (!role) return false;
  const row = await dbOne('SELECT permission FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?', [mailboxId, userId]);
  if (!row) return false;
  if (!write) return true;
  return String(row.permission) !== 'read';
}

export async function listWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await dbQuery('SELECT workspace_id FROM memberships WHERE user_id = ?', [userId]);
  return rows.map((r) => String(r.workspace_id));
}
