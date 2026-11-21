import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, listWorkspaceIds} from '@/lib/guards';
import {encryptSecret} from '@/lib/crypto';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const ids = await listWorkspaceIds(user.id);
  if (!ids.length) return NextResponse.json({providers: []});
  const providers = await dbQuery(
    `SELECT id, workspace_id, provider, enabled, priority, sender_verified, last_test_at, created_at FROM provider_secrets
     WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY priority ASC`,
    ids,
  );
  return NextResponse.json({providers});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      provider: z.enum(['brevo', 'mailjet', 'resend', 'sendpulse']),
      api_key: z.string().min(8).max(4096),
      api_secret: z.string().max(4096).optional(),
      priority: z.number().int().min(1).max(1000).default(100),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid provider configuration'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin permission required'}, {status: 403});
  try {
    const payload = JSON.stringify({api_key: p.data.api_key, api_secret: p.data.api_secret || ''});
    const now = nowIso();
    await dbRun(
      `INSERT INTO provider_secrets (id, workspace_id, provider, secret_ciphertext, key_version, enabled, priority, sender_verified, created_at)
       VALUES (?, ?, ?, ?, 'v1', 1, ?, 0, ?)
       ON CONFLICT(workspace_id, provider) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
         enabled = 1, priority = excluded.priority, sender_verified = 0`,
      [newId(), p.data.workspace_id, p.data.provider, encryptSecret(payload), p.data.priority, now],
    );
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), p.data.workspace_id, user.id, 'provider.connected', 'provider', p.data.provider, now],
    );
    return NextResponse.json({success: true, provider: p.data.provider});
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Provider save failed'}, {status: 500});
  }
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      provider: z.enum(['brevo', 'mailjet', 'resend', 'sendpulse']),
      sender_verified: z.boolean(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid verification update'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin permission required'}, {status: 403});
  const d = await dbOne(
    "SELECT id FROM domains WHERE workspace_id = ? AND ownership_status = 'verified' AND dns_status = 'verified' LIMIT 1",
    [p.data.workspace_id],
  );
  if (p.data.sender_verified && !d)
    return NextResponse.json(
      {error: 'Verify at least one domain and its DNS before confirming provider sender verification.'},
      {status: 409},
    );
  const now = nowIso();
  const r = await dbRun(
    'UPDATE provider_secrets SET sender_verified = ?, last_test_at = ? WHERE workspace_id = ? AND provider = ?',
    [p.data.sender_verified ? 1 : 0, now, p.data.workspace_id, p.data.provider],
  );
  if (r.changes === 0)
    return NextResponse.json({error: 'Provider not configured for this workspace'}, {status: 404});
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), p.data.workspace_id, user.id, 'provider.sender_verification_attested', 'provider', p.data.provider, now],
  );
  return NextResponse.json({
    success: true,
    warning: 'This is an administrator attestation. Confirm the sender/domain is verified in the provider dashboard first.',
  });
}
