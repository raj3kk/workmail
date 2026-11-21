import {NextResponse} from 'next/server';
import {z} from 'zod';
import {createHash, randomUUID} from 'node:crypto';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox, workspaceRole} from '@/lib/guards';
import {decryptSecret} from '@/lib/crypto';

export const runtime = 'nodejs';

const schema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    text: z.string().max(100000).optional(),
    html: z.string().max(200000).optional(),
    workspace_id: z.string().uuid(),
    mailbox_id: z.string().uuid().optional(),
  })
  .refine((x) => !!(x.text || x.html));

async function timed(url: string, init: RequestInit): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10000);
  try {
    return await fetch(url, {...init, signal: c.signal, cache: 'no-store'});
  } finally {
    clearTimeout(t);
  }
}

async function sendProvider(provider: string, secret: any, from: string, name: string, d: any): Promise<any> {
  const key = secret.api_key;
  const sec = secret.api_secret;
  if (provider === 'sendpulse') {
    const tokenRes = await timed('https://api.sendpulse.com/oauth/access_token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({grant_type: 'client_credentials', client_id: key, client_secret: sec}),
    });
    if (!tokenRes.ok) throw new Error(`SendPulse auth HTTP ${tokenRes.status}`);
    const token = await tokenRes.json();
    const r = await timed('https://api.sendpulse.com/smtp/emails', {
      method: 'POST',
      headers: {Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({email: {subject: d.subject, from: {name, email: from}, to: [{email: d.to}], text: d.text, html: d.html}}),
    });
    if (!r.ok) throw new Error(`SendPulse HTTP ${r.status}`);
    return r.json();
  }
  if (provider === 'brevo') {
    const r = await timed('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {'api-key': key, 'Content-Type': 'application/json'},
      body: JSON.stringify({sender: {name, email: from}, to: [{email: d.to}], subject: d.subject, textContent: d.text, htmlContent: d.html}),
    });
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}`);
    return r.json();
  }
  if (provider === 'mailjet') {
    const auth = Buffer.from(key + ':' + sec).toString('base64');
    const r = await timed('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {Authorization: 'Basic ' + auth, 'Content-Type': 'application/json'},
      body: JSON.stringify({Messages: [{From: {Email: from, Name: name}, To: [{Email: d.to}], Subject: d.subject, TextPart: d.text, HTMLPart: d.html, CustomID: d.idempotency_key}]}),
    });
    if (!r.ok) throw new Error(`Mailjet HTTP ${r.status}`);
    return r.json();
  }
  if (provider === 'resend') {
    const r = await timed('https://api.resend.com/emails', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': d.idempotency_key},
      body: JSON.stringify({from: `${name} <${from}>`, to: [d.to], subject: d.subject, text: d.text, html: d.html}),
    });
    if (!r.ok) throw new Error(`Resend HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`Provider ${provider} adapter is not enabled yet`);
}

async function markKey(workspaceId: string, key: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const sets = ['status = ?'];
  const values: unknown[] = [status];
  if (extra.provider !== undefined) {
    sets.push('provider = ?');
    values.push(extra.provider);
  }
  if (extra.provider_message_id !== undefined) {
    sets.push('provider_message_id = ?');
    values.push(extra.provider_message_id);
  }
  if (extra.message_id !== undefined) {
    sets.push('message_id = ?');
    values.push(extra.message_id);
  }
  sets.push('updated_at = ?');
  values.push(nowIso(), workspaceId, key);
  await dbRun(`UPDATE idempotency_keys SET ${sets.join(', ')} WHERE workspace_id = ? AND idempotency_key = ?`, values);
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid message', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const memberRole = await workspaceRole(user.id, d.workspace_id);
  if (!memberRole) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const boxes = await dbQuery(
    'SELECT id, address, display_name, domain_id FROM mailboxes WHERE workspace_id = ? AND is_active = 1' +
      (d.mailbox_id ? ' AND id = ?' : '') +
      ' LIMIT 20',
    d.mailbox_id ? [d.workspace_id, d.mailbox_id] : [d.workspace_id],
  );
  let sender: any = null;
  for (const b of boxes) {
    if (await canAccessMailbox(user.id, String(b.id), true)) {
      sender = b;
      break;
    }
  }
  if (!sender)
    return NextResponse.json({error: 'No mailbox assigned to you with send permission.'}, {status: 403});
  const domain = await dbOne('SELECT ownership_status, dns_status FROM domains WHERE id = ?', [sender.domain_id]);
  if (!domain || domain.ownership_status !== 'verified' || domain.dns_status !== 'verified')
    return NextResponse.json({error: 'Verify domain ownership and email DNS before sending.'}, {status: 409});
  const key = req.headers.get('idempotency-key') || randomUUID();
  const hash = createHash('sha256')
    .update(JSON.stringify({to: d.to, subject: d.subject, text: d.text, html: d.html, mailbox: sender.id}))
    .digest('hex');
  const existing = await dbOne(
    'SELECT * FROM idempotency_keys WHERE workspace_id = ? AND idempotency_key = ?',
    [d.workspace_id, key],
  );
  if (existing) {
    if (existing.request_hash !== hash)
      return NextResponse.json({error: 'Idempotency key reused with different content'}, {status: 409});
    if (existing.status === 'accepted')
      return NextResponse.json({success: true, duplicate: true, provider: existing.provider, messageId: existing.provider_message_id});
    return NextResponse.json(
      {error: 'This send is already processing or has an unknown provider outcome. Check delivery logs before retrying.'},
      {status: 409},
    );
  }
  try {
    await dbRun(
      'INSERT INTO idempotency_keys (workspace_id, idempotency_key, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [d.workspace_id, key, hash, 'processing', nowIso(), nowIso()],
    );
  } catch {
    return NextResponse.json({error: 'Could not reserve send request'}, {status: 409});
  }
  const settings = await dbOne('SELECT monthly_send_limit FROM workspace_settings WHERE workspace_id = ?', [d.workspace_id]);
  const period = new Date().toISOString().slice(0, 7) + '-01';
  const usage = await dbOne('SELECT sent_count FROM usage_counters WHERE workspace_id = ? AND period_start = ?', [
    d.workspace_id,
    period,
  ]);
  if ((usage?.sent_count || 0) >= (settings?.monthly_send_limit || 300)) {
    await markKey(d.workspace_id, key, 'failed');
    return NextResponse.json({error: 'Monthly sending limit reached.'}, {status: 429});
  }
  const suppressed = await dbOne('SELECT email, reason FROM suppressions WHERE workspace_id = ? AND email = ?', [
    d.workspace_id,
    d.to.toLowerCase(),
  ]);
  if (suppressed) {
    await markKey(d.workspace_id, key, 'failed');
    return NextResponse.json(
      {error: 'Recipient is on this workspace suppression list.', reason: suppressed.reason},
      {status: 409},
    );
  }
  const configs = await dbQuery(
    'SELECT provider, secret_ciphertext, priority, sender_verified FROM provider_secrets WHERE workspace_id = ? AND enabled = 1 AND sender_verified = 1 ORDER BY priority ASC',
    [d.workspace_id],
  );
  if (!configs?.length) {
    await markKey(d.workspace_id, key, 'failed');
    return NextResponse.json({error: 'Connect a provider and verify the sender domain first.'}, {status: 503});
  }
  const attempts: any[] = [];
  const from = sender.address;
  const name = sender.display_name || 'WorkMail';
  for (const config of configs) {
    try {
      const secret = JSON.parse(decryptSecret(config.secret_ciphertext));
      const result = await sendProvider(config.provider, secret, from, name, {...d, idempotency_key: key});
      const providerId = result?.messageId || result?.id || result?.Messages?.[0]?.To?.[0]?.MessageID || null;
      const msgId = newId();
      const now = nowIso();
      await dbRun(
        `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, provider, delivery_state, message_id, received_at, created_at, updated_at)
         VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
        [msgId, d.workspace_id, sender.id, from, d.to, d.subject, d.text || '', d.html || '', config.provider, key, now, now, now],
      );
      await markKey(d.workspace_id, key, 'accepted', {
        provider: config.provider,
        provider_message_id: String(providerId || ''),
        message_id: msgId,
      });
      await dbRun(
        `INSERT INTO usage_counters (workspace_id, period_start, sent_count, received_count, storage_bytes)
         VALUES (?, ?, 1, 0, 0)
         ON CONFLICT(workspace_id, period_start) DO UPDATE SET sent_count = usage_counters.sent_count + 1`,
        [d.workspace_id, period],
      );
      await dbRun(
        'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newId(), d.workspace_id, user.id, 'email.accepted', 'message', msgId, now],
      );
      return NextResponse.json({success: true, provider: config.provider, messageId: providerId, attempts});
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Provider error';
      attempts.push({provider: config.provider, reason});
      if (
        reason.toLowerCase().includes('abort') ||
        reason.toLowerCase().includes('timeout') ||
        reason.toLowerCase().includes('network')
      ) {
        await markKey(d.workspace_id, key, 'unknown', {provider: config.provider});
        return NextResponse.json(
          {error: 'Provider outcome unknown after timeout. Do not resend until provider logs are checked.', attempts},
          {status: 202},
        );
      }
    }
  }
  await markKey(d.workspace_id, key, 'failed');
  return NextResponse.json({success: false, error: 'All configured providers rejected the send.', attempts}, {status: 502});
}
