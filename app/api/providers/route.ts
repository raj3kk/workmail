import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, listWorkspaceIds} from '@/lib/guards';
import {encryptSecret, decryptSecret} from '@/lib/crypto';
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
    `SELECT id, workspace_id, provider, enabled, priority, sender_verified, sender_attested, sender_verified_via, last_test_at, created_at FROM provider_secrets
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
      // G-25 two-state: sender_verified here means PROVIDER-CONFIRMED
      // (sender_verified_via = 'provider'). sender_attested is the
      // user-asserted state (the old "I verified sender" button).
      // Send eligibility accepts either (see lib/service-send.ts); the
      // UI must show them distinctly: "Verified by provider" vs
      // "Attested by you — not confirmed with provider".
      sender_verified: row ? row.sender_verified === 1 && row.sender_verified_via === 'provider' : false,
      sender_attested: row ? row.sender_attested === 1 : false,
      sender_verified_via: row ? row.sender_verified_via || null : null,
      sender_state: !row
        ? 'unverified'
        : row.sender_verified === 1 && row.sender_verified_via === 'provider'
          ? 'verified'
          : row.sender_attested === 1
            ? 'attested'
            : 'unverified',
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
      `INSERT INTO provider_secrets (id, workspace_id, provider, secret_ciphertext, key_version, enabled, priority, sender_verified, sender_attested, sender_verified_via, created_at)
       VALUES (?, ?, ?, ?, 'v1', 1, ?, 0, 0, NULL, ?)
       ON CONFLICT(workspace_id, provider) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
         enabled = 1, priority = excluded.priority, sender_verified = 0, sender_attested = 0, sender_verified_via = NULL`,
      [newId(), p.data.workspace_id, p.data.provider, encryptSecret(payload), priority, now],
    );
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), p.data.workspace_id, user.id, 'provider.connected', 'provider', p.data.provider, now],
    );
    return NextResponse.json({success: true, provider: p.data.provider, priority});
  } catch (e) {
    return NextResponse.json({error: 'Provider save failed'}, {status: 500});
  }
}

// ---------------------------------------------------------------------------
// "Verify now" (G-25): confirm the sender against the provider's own
// sender/domain API. Each check below uses ONLY the workspace's stored
// secret + the workspace's own verified domains / mailbox addresses.
// A check that cannot confirm the sender returns verified:false with a
// reason — it NEVER sets sender_verified on a guess, a timeout, or an
// unrecognised API response. Attestation (below) is the only other way
// a row becomes send-eligible, and it is labelled as such.
async function fetchJson(url: string, init: RequestInit): Promise<{ok: boolean; status: number; body: unknown}> {
  const r = await fetch(url, {...init, cache: 'no-store', signal: AbortSignal.timeout(8000)});
  const body = await r.json().catch(() => null);
  return {ok: r.ok, status: r.status, body};
}

async function providerVerifyCheck(
  provider: ProviderName,
  secret: {api_key: string; api_secret?: string},
  workspaceId: string,
): Promise<{verified: boolean; checked: boolean; reason: string}> {
  const domains = await dbQuery(
    "SELECT domain FROM domains WHERE workspace_id = ? AND ownership_status = 'verified' AND dns_status = 'verified'",
    [workspaceId],
  ).catch(() => []);
  const verifiedDomains = new Set((domains || []).map((d) => String(d.domain).toLowerCase()));
  const boxes = await dbQuery('SELECT address FROM mailboxes WHERE workspace_id = ? AND is_active = 1', [workspaceId]).catch(() => []);
  const mailboxAddresses = new Set((boxes || []).map((b) => String(b.address).toLowerCase()));
  try {
    if (provider === 'resend') {
      const r = await fetchJson('https://api.resend.com/domains', {
        headers: {Authorization: 'Bearer ' + secret.api_key},
      });
      if (!r.ok) return {verified: false, checked: false, reason: `Resend domain check failed (HTTP ${r.status}) — sender not confirmed.`};
      const list = Array.isArray((r.body as {data?: unknown})?.data) ? ((r.body as {data: Array<{name?: string; status?: string}>}).data) : [];
      const hit = list.find((d) => d.name && verifiedDomains.has(d.name.toLowerCase()) && d.status === 'verified');
      return hit
        ? {verified: true, checked: true, reason: `Resend confirms domain ${hit.name} is verified.`}
        : {verified: false, checked: true, reason: 'Resend has no verified domain matching this workspace — verify the domain in Resend first.'};
    }
    if (provider === 'brevo') {
      const r = await fetchJson('https://api.brevo.com/v3/senders', {
        headers: {'api-key': secret.api_key},
      });
      if (!r.ok) return {verified: false, checked: false, reason: `Brevo sender check failed (HTTP ${r.status}) — sender not confirmed.`};
      const list = Array.isArray((r.body as {senders?: unknown})?.senders) ? ((r.body as {senders: Array<{email?: string; active?: boolean}>}).senders) : [];
      const hit = list.find((s) => s.email && mailboxAddresses.has(s.email.toLowerCase()) && s.active === true);
      return hit
        ? {verified: true, checked: true, reason: `Brevo confirms sender ${hit.email} is active.`}
        : {verified: false, checked: true, reason: 'Brevo has no active sender matching a mailbox address in this workspace — add and verify the sender in Brevo first.'};
    }
    if (provider === 'mailjet') {
      const auth = Buffer.from(secret.api_key + ':' + (secret.api_secret || '')).toString('base64');
      const r = await fetchJson('https://api.mailjet.com/v3/sender', {
        headers: {Authorization: 'Basic ' + auth},
      });
      if (!r.ok) return {verified: false, checked: false, reason: `Mailjet sender check failed (HTTP ${r.status}) — sender not confirmed.`};
      const list = Array.isArray((r.body as {Data?: unknown})?.Data) ? ((r.body as {Data: Array<{Email?: string; Status?: string}>}).Data) : [];
      const hit = list.find((s) => s.Email && mailboxAddresses.has(s.Email.toLowerCase()) && s.Status === 'Active');
      return hit
        ? {verified: true, checked: true, reason: `Mailjet confirms sender ${hit.Email} is Active.`}
        : {verified: false, checked: true, reason: 'Mailjet has no Active sender matching a mailbox address in this workspace — add and verify the sender in Mailjet first.'};
    }
    // sendpulse: token first, then the sender list. The /senders shape is
    // not guaranteed, so an unrecognised response is "not confirmed"
    // rather than a guess.
    const tokenRes = await fetchJson('https://api.sendpulse.com/oauth/access_token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({grant_type: 'client_credentials', client_id: secret.api_key, client_secret: secret.api_secret || ''}),
    });
    const token = (tokenRes.body as {access_token?: string} | null)?.access_token;
    if (!tokenRes.ok || !token) return {verified: false, checked: false, reason: 'SendPulse auth failed for the sender check — sender not confirmed.'};
    const r = await fetchJson('https://api.sendpulse.com/senders', {
      headers: {Authorization: 'Bearer ' + token},
    });
    if (!r.ok) return {verified: false, checked: false, reason: `SendPulse sender check failed (HTTP ${r.status}) — sender not confirmed.`};
    const list = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
    const hit = list.find((s) => {
      const email = typeof s.email === 'string' ? s.email.toLowerCase() : '';
      const status = s.status;
      return email && mailboxAddresses.has(email) && (status === 'active' || status === 'Active' || status === true);
    });
    if (hit) return {verified: true, checked: true, reason: `SendPulse confirms sender ${String(hit.email)} is active.`};
    return {verified: false, checked: false, reason: 'SendPulse did not return a sender list this check understands — sender not confirmed; attestation only.'};
  } catch (e) {
    return {verified: false, checked: false, reason: 'Provider check could not be reached (network error) — sender not confirmed.'};
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
      sender_attested: z.boolean().optional(),
      verify_now: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .refine(
      (x) =>
        x.sender_verified !== undefined ||
        x.sender_attested !== undefined ||
        x.verify_now !== undefined ||
        x.enabled !== undefined,
    )
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid verification update'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin permission required'}, {status: 403});
  const d = await dbOne(
    "SELECT id FROM domains WHERE workspace_id = ? AND ownership_status = 'verified' AND dns_status = 'verified' LIMIT 1",
    [p.data.workspace_id],
  );
  const now = nowIso();
  // "Verify now": confirm against the provider's own API. On success the
  // row becomes provider-verified (sender_verified_via = 'provider'); on
  // any other outcome NOTHING is written and the reason is returned.
  if (p.data.verify_now) {
    if (!d)
      return NextResponse.json(
        {error: 'Verify at least one domain and its DNS before confirming provider sender verification.'},
        {status: 409},
      );
    const row = await dbOne(
      'SELECT secret_ciphertext FROM provider_secrets WHERE workspace_id = ? AND provider = ?',
      [p.data.workspace_id, p.data.provider],
    );
    if (!row) return NextResponse.json({error: 'Provider not configured for this workspace'}, {status: 404});
    let secret: {api_key: string; api_secret?: string};
    try {
      secret = JSON.parse(decryptSecret(String(row.secret_ciphertext)));
    } catch {
      return NextResponse.json({error: 'Stored provider secret could not be decrypted. Re-save the provider credentials.'}, {status: 502});
    }
    const check = await providerVerifyCheck(p.data.provider, secret, p.data.workspace_id);
    if (!check.verified)
      return NextResponse.json(
        {error: check.reason, provider_check: {checked: check.checked, verified: false}},
        {status: check.checked ? 409 : 502},
      );
    await dbRun(
      `UPDATE provider_secrets SET sender_verified = 1, sender_attested = 1, sender_verified_via = 'provider', last_test_at = ? WHERE workspace_id = ? AND provider = ?`,
      [now, p.data.workspace_id, p.data.provider],
    );
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), p.data.workspace_id, user.id, 'provider.sender_verified', 'provider', p.data.provider, now],
    );
    return NextResponse.json({success: true, sender_state: 'verified', provider_check: {checked: true, verified: true, reason: check.reason}});
  }
  // Attestation (new sender_attested, or legacy sender_verified from the
  // Settings page's "I verified sender in provider" button): the sender
  // is asserted BY THE USER, not confirmed with the provider. It stays
  // send-eligible (current behaviour), but sender_verified_via stays
  // 'attested' so the UI can say so honestly.
  const attest = p.data.sender_attested !== undefined ? p.data.sender_attested : p.data.sender_verified;
  if (attest && !d)
    return NextResponse.json(
      {error: 'Verify at least one domain and its DNS before confirming provider sender verification.'},
      {status: 409},
    );
  const sets: string[] = ['last_test_at = ?'];
  const values: unknown[] = [now];
  if (attest !== undefined) {
    if (attest) {
      sets.push('sender_attested = 1', 'sender_verified = 1', "sender_verified_via = 'attested'");
    } else {
      // Withdrawing the attestation clears eligibility — UNLESS the row
      // is provider-confirmed (via = 'provider'), which attestation
      // never granted and cannot take away.
      sets.push(
        'sender_attested = 0',
        "sender_verified = CASE WHEN sender_verified_via = 'provider' THEN 1 ELSE 0 END",
        "sender_verified_via = CASE WHEN sender_verified_via = 'provider' THEN 'provider' ELSE NULL END",
      );
    }
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
      attest !== undefined ? 'provider.sender_verification_attested' : 'provider.enabled_changed',
      'provider',
      p.data.provider,
      now,
    ],
  );
  return NextResponse.json({
    success: true,
    sender_state: attest ? 'attested' : undefined,
    warning:
      attest !== undefined
        ? 'This is an administrator attestation — the sender was asserted by you, not confirmed with the provider. Use "Verify now" to confirm it with the provider.'
        : undefined,
  });
}
