import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {newSessionToken, hashToken} from '@/lib/mfa';

// Google OAuth (authorization-code flow) + D1-backed sessions.
// No third-party auth service. Sessions are opaque random tokens
// stored hashed in D1 (revocable server-side); the cookie is httpOnly.
export interface SessionUser {
  id: string; email: string; name: string | null;
  mfa_secret: string | null; suspended_at: string | null;
}

const COOKIE = '__Host-wm_session';
// __Host- prefix (G-10): the cookie is only ever sent to this exact
// host, never to subdomains, and the prefix itself forces Secure +
// Path=/ with no Domain attribute (all already true here). Browsers
// holding the old `wm_session` cookie are logged out once on their
// next request and get the new cookie at their next login.

export function getSessionToken(req: Request): string | null {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookie(token: string): string {
  const maxAge = 30 * 24 * 60 * 60;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

export async function getSessionUser(req: Request): Promise<{user: SessionUser | null; session: any | null}> {
  const token = getSessionToken(req);
  if (!token) return {user: null, session: null};
  const session = await dbOne(
    'SELECT id, user_id, expires_at, mfa_verified FROM sessions WHERE token_hash = ? AND expires_at > ?',
    [hashToken(token), nowIso()]);
  if (!session) return {user: null, session: null};
  const user = await dbOne(
    'SELECT id, email, display_name, mfa_secret, suspended_at FROM users WHERE id = ?',
    [session.user_id]);
  if (!user) return {user: null, session: null};
  return {
    user: {id: user.id, email: user.email, name: user.display_name || null, mfa_secret: user.mfa_secret || null, suspended_at: user.suspended_at || null},
    session,
  };
}

export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await dbRun(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [newId(), userId, hashToken(token), expires, nowIso()]);
  return token;
}

export async function destroySession(req: Request): Promise<void> {
  const token = getSessionToken(req);
  if (token) await dbRun('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export async function markSessionMfaVerified(sessionId: string): Promise<void> {
  await dbRun('UPDATE sessions SET mfa_verified = 1 WHERE id = ?', [sessionId]);
}

// Session revocation (G-10). Returns the number of sessions destroyed.
// With exceptSessionId set, every OTHER session of the user is
// destroyed (the revoke-all endpoint); without it, all of them are
// (login rotation: the fresh session created after this call is the
// user's only live session).
export async function revokeAllSessions(userId: string, exceptSessionId?: string | null): Promise<number> {
  if (exceptSessionId) {
    const r = await dbRun('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, exceptSessionId]);
    return r.changes;
  }
  const r = await dbRun('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return r.changes;
}

// Reconcile a user's workspace scaffolding (G-18): make sure the user
// has at least one workspace with owner membership, workspace
// settings, and an active subscription, creating whichever pieces are
// missing. Every step is idempotent (INSERT OR IGNORE / existence
// checks), so it is safe to run on every login — it is the self-heal
// for a signup that died mid-sequence, and the normal path for a
// user whose rows were cleaned up by the compensation below.
export async function ensureUserWorkspace(userId: string, email: string, displayName: string | null): Promise<string> {
  const now = nowIso();
  const existing = await dbOne(
    'SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
    [userId],
  );
  let workspaceId = existing?.workspace_id ? String(existing.workspace_id) : null;
  if (!workspaceId) {
    workspaceId = newId();
    await dbRun('INSERT INTO workspaces (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      `${displayName || email}'s Workspace`,
      userId,
      now,
    ]);
  }
  await dbRun('INSERT OR IGNORE INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', [
    workspaceId,
    userId,
    'owner',
    now,
  ]);
  // Self-heal (2026-11-22): the workspace's recorded owner must hold
  // the owner role. A team-role change once demoted the owner to
  // 'member' (the /api/team upsert overwrote the role), which silently
  // revoked the owner's filters/labels/contacts admin rights and broke
  // mailbox access for the All view. Runs on every login.
  await dbRun(
    `UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = (SELECT owner_user_id FROM workspaces WHERE id = ?) AND role != 'owner'`,
    [workspaceId, workspaceId],
  );
  await dbRun(
    'INSERT OR IGNORE INTO workspace_settings (workspace_id, plan, monthly_send_limit, retention_days, created_at) VALUES (?, ?, 300, 90, ?)',
    [workspaceId, 'free', now],
  );
  const sub = await dbOne(
    "SELECT id FROM subscriptions WHERE workspace_id = ? AND status IN ('pending','active','past_due') LIMIT 1",
    [workspaceId],
  );
  if (!sub) {
    await dbRun(
      'INSERT INTO subscriptions (id, workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), workspaceId, 'free', 'active', now, now],
    );
  }
  return workspaceId;
}

// Google userinfo -> user row. First login creates the user, a personal
// workspace, owner membership, workspace settings and a free subscription
// (previously done by a database trigger; now explicit application code).
//
// G-18: the create sequence is NOT atomic (dbBatch is sequential
// /query calls — see lib/db.ts), so a failure mid-sequence used to
// leave partial rows (a user with no workspace, or a workspace with
// no settings/subscription). Two defences now apply:
//   1. Compensation: if any step throws, the rows created in THIS
//      attempt are deleted in reverse dependency order and the error
//      is rethrown, so the login fails cleanly instead of half-creating
//      an account.
//   2. Reconcile on next login: every login (new or returning user)
//      runs ensureUserWorkspace, which rebuilds any missing piece
//      idempotently — so even a partial row set left behind by an
//      older failure (or a cleanup that itself failed) heals itself
//      the next time the user signs in.
export async function upsertGoogleUser(profile: {sub: string; email: string; name?: string | null}): Promise<SessionUser> {
  const email = profile.email.toLowerCase();
  const existing = await dbOne('SELECT id, email, display_name, mfa_secret, suspended_at FROM users WHERE google_sub = ? OR email = ?', [profile.sub, email]);
  if (existing) {
    await dbRun('UPDATE users SET google_sub = ?, display_name = ?, updated_at = ? WHERE id = ?', [profile.sub, profile.name || existing.display_name, nowIso(), existing.id]);
    await ensureUserWorkspace(String(existing.id), String(existing.email), profile.name || existing.display_name || null);
    return {id: existing.id, email: existing.email, name: profile.name || existing.display_name || null, mfa_secret: existing.mfa_secret || null, suspended_at: existing.suspended_at || null};
  }
  const userId = newId();
  const workspaceId = newId();
  const now = nowIso();
  try {
    await dbRun('INSERT INTO users (id, email, google_sub, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, email, profile.sub, profile.name || '', now, now]);
    await dbRun('INSERT INTO workspaces (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)', [workspaceId, `${profile.name || email}'s Workspace`, userId, now]);
    await dbRun('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', [workspaceId, userId, 'owner', now]);
    await dbRun('INSERT INTO workspace_settings (workspace_id, plan, monthly_send_limit, retention_days, created_at) VALUES (?, ?, 300, 90, ?)', [workspaceId, 'free', now]);
    await dbRun('INSERT INTO subscriptions (id, workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), workspaceId, 'free', 'active', now, now]);
  } catch (e) {
    // Compensation (G-18): delete the partial rows from this attempt,
    // reverse dependency order. Each delete is failure-isolated: even
    // if cleanup itself fails, reconcile-on-next-login rebuilds the
    // missing pieces when the user retries.
    await dbRun('DELETE FROM subscriptions WHERE workspace_id = ?', [workspaceId]).catch(() => {});
    await dbRun('DELETE FROM workspace_settings WHERE workspace_id = ?', [workspaceId]).catch(() => {});
    await dbRun('DELETE FROM memberships WHERE workspace_id = ?', [workspaceId]).catch(() => {});
    await dbRun('DELETE FROM workspaces WHERE id = ?', [workspaceId]).catch(() => {});
    await dbRun('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
    throw e;
  }
  await maybeBootstrapAdmin(userId, email);
  return {id: userId, email, name: profile.name || null, mfa_secret: null, suspended_at: null};
}

// First platform admin bootstrap: if the user's email is listed in
// PLATFORM_ADMIN_EMAILS (host env), grant platform_admins on first login.
// No manual SQL, no default admin. Leave the env empty to disable.
export async function maybeBootstrapAdmin(userId: string, email: string): Promise<void> {
  const list = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.includes(email.toLowerCase())) return;
  await dbRun('INSERT OR IGNORE INTO platform_admins (user_id, granted_at) VALUES (?, ?)', [userId, nowIso()]);
}

export function googleAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    response_type: 'code', scope: 'openid email profile',
    access_type: 'offline', prompt: 'select_account', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export async function exchangeGoogleCode(code: string): Promise<{sub: string; email: string; name?: string | null}> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`, grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (HTTP ${tokenRes.status})`);
  const tokens: any = await tokenRes.json();
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {Authorization: `Bearer ${tokens.access_token}`}, signal: AbortSignal.timeout(15000),
  });
  if (!infoRes.ok) throw new Error('Google userinfo fetch failed');
  const info: any = await infoRes.json();
  if (!info.sub || !info.email) throw new Error('Google profile missing sub/email');
  // G-11: only a Google-verified email may create or claim an account.
  // An unverified address in the profile must never become a WorkMail
  // identity (it could belong to someone else's inbox).
  if (info.email_verified !== true) throw new Error('Google email is not verified');
  return {sub: info.sub, email: info.email, name: info.name || null};
}

export async function listUserWorkspaces(userId: string): Promise<any[]> {
  return dbQuery(
    'SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC',
    [userId]);
}
