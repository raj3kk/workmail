import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, listWorkspaceIds} from '@/lib/guards';
import {encryptSecret} from '@/lib/crypto';
import {
  PROVIDER_CHAIN,
  PROVIDER_CAPS,
  PROVIDER_DEFAULT_PRIORITY,
  getCapState,
  hasEnvCredentials,
  type ProviderName,
} from '@/lib/providers';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const ids = await listWorkspaceIds(user.id);
  if (!ids.length)
    return NextResponse.json({
      providers: [],
      chain: PROVIDER_CHAIN.map((p) => ({provider: p, caps: PROVIDER_CAPS[p], env_configured: hasEnvCredentials(p)})),
    });
  const rows = await dbQuery(
    `SELECT id, workspace_id, provider, enabled, priority, sender_verified, last_test_at, created_at FROM provider_secrets
     WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY priority ASC`,
    ids,
  );
  // Live per-provider status: chain order, caps, current D1-backed usage,
  // and whether a host env fallback exists (boolean only — never a value).
  // Cap state is computed per workspace the caller belongs to; when the
  // caller has several workspaces the first one is used for the usage
  // snapshot (per-workspace detail is available via the send path logs).
  const workspaceId = String(ids[0]);
  const providers = [];
  for (const provider of PROVIDER_CHAIN) {
    const row = (rows || []).find((r: any) => r.provider === provider);
    let cap = null;
    try {
      cap = await getCapState(workspaceId, provider);
    } catch {
      cap = null;
    }
    providers.push({
      provider,
      configured: !!row,
      enabled: row ? row.enabled === 1 : false,
      priority: row ? row.priority : PROVIDER_DEFAULT_PRIORITY[provider],
      sender_verified: row ? row.sender_verified === 1 : false,
      last_test_at: row ? row.last_test_at : null,
      created_at: row ? row.created_at : null,
      workspace_id: row ? row.workspace_id : null,
      caps: PROVIDER_CAPS[provider],
      cap_state: cap,
      env_configured: hasEnvCredentials(provider),
      chain_position: PROVIDER_CHAIN.indexOf(provider) + 1,
    });
  }
  return NextResponse.json({providers, chain: PROVIDER_CHAIN});
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
      // Default follows the fixed fallback chain order (SendPulse 10,
      // Brevo 20, Mailjet 30, Resend 40); an explicit value overrides it.
      priority: z.number().int().min(1).max(1000).optional(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid provider configuration'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin permission required'}, {status: 403});
  const priority = p.data.priority ?? PROVIDER_DEFAULT_PRIORITY[p.data.provider as ProviderName];
  try {
    const payload = JSON.stringify({api_key: p.data.api_key, api_secret: p.data.api_secret || ''});
    const now = nowIso();
    await dbRun(
      `INSERT INTO provider_secrets (id, workspace_id, provider, secret_ciphertext, key_version, enabled, priority, sender_verified, created_at)
       VALUES (?, ?, ?, ?, 'v1', 1, ?, 0, ?)
       ON CONFLICT(workspace_id, provider) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
         enabled = 1, priority = excluded.priority, sender_verified = 0`,
      [newId(), p.data.workspace_id, p.data.provider, encryptSecret(payload), priority, now],
    );
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), p.data.workspace_id, user.id, 'provider.connected', 'provider', p.data.provider, now],
    );
    return NextResponse.json({success: true, provider: p.data.provider, priority});
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
      sender_verified: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .refine((x) => x.sender_verified !== undefined || x.enabled !== undefined)
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
  const sets: string[] = ['last_test_at = ?'];
  const values: unknown[] = [now];
  if (p.data.sender_verified !== undefined) {
    sets.push('sender_verified = ?');
    values.push(p.data.sender_verified ? 1 : 0);
  }
  if (p.data.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(p.data.enabled ? 1 : 0);
  }
  const r = await dbRun(
    `UPDATE provider_secrets SET ${sets.join(', ')} WHERE workspace_id = ? AND provider = ?`,
    [...values, p.data.workspace_id, p.data.provider],
  );
  if (r.changes === 0)
    return NextResponse.json({error: 'Provider not configured for this workspace'}, {status: 404});
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      newId(),
      p.data.workspace_id,
      user.id,
      p.data.sender_verified !== undefined ? 'provider.sender_verification_attested' : 'provider.enabled_changed',
      'provider',
      p.data.provider,
      now,
    ],
  );
  return NextResponse.json({
    success: true,
    warning:
      p.data.sender_verified !== undefined
        ? 'This is an administrator attestation. Confirm the sender/domain is verified in the provider dashboard first.'
        : undefined,
  });
}
