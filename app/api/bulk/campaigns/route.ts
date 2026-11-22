// /api/bulk/campaigns — list + create bulk campaigns.
//
// POST creates a `draft` campaign and its recipients. The client normally
// posts the `recipients` array returned by POST /api/bulk/parse, but the
// server re-validates everything: emails, dedupe, suppression, and the
// BULK_MAX_RECIPIENTS cap — a hand-crafted request cannot bypass them.
// The From address must be one of the workspace's own mailboxes and the
// caller must have send permission on it (canAccessMailbox, write).
// Every recipient gets its deterministic idempotency key at creation
// time, so start/stop/resume can never duplicate a send.
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {canAccessMailbox, requireUser, workspaceRole} from '@/lib/guards';
import {
  BULK_MAX_RECIPIENTS,
  bulkIdempotencyKey,
  getBulkCampaignSummary,
  isValidEmail,
  loadSuppressionMap,
  monthlySendRemaining,
} from '@/lib/bulk';

export const runtime = 'nodejs';

const recipientSchema = z.object({
  email: z.string(),
  name: z.string().max(200).optional().default(''),
  fields: z.record(z.string()).optional().default({}),
});

const createSchema = z
  .object({
    workspace_id: z.string().uuid(),
    mailbox_id: z.string().uuid(),
    name: z.string().max(200).optional().default(''),
    subject: z.string().min(1).max(998),
    text: z.string().max(100000).optional().default(''),
    html: z.string().max(200000).optional().default(''),
    recipients: z.array(recipientSchema).min(1).max(BULK_MAX_RECIPIENTS),
    // Per-campaign provider choice (F3): 'auto' = fallback chain, or one
    // provider name = ONLY that provider, no silent fallback (enforced
    // in the send engine). Stored on the campaign row.
    provider: z.enum(['auto', 'sendpulse', 'brevo', 'mailjet', 'resend']).optional().default('auto'),
  })
  .refine((x) => !!(x.text || x.html), {message: 'Provide a text body, an HTML body, or both.'});

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id is required.'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const rows = await dbQuery(
    'SELECT * FROM bulk_campaigns WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20',
    [workspaceId],
  );
  const campaigns = [];
  for (const row of rows) {
    const summary = await getBulkCampaignSummary(String(row.id));
    if (summary) campaigns.push(summary);
  }
  return NextResponse.json({campaigns});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid campaign', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;

  const role = await workspaceRole(user.id, d.workspace_id);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  // From address: only the workspace's own mailboxes, and only with send
  // permission. A mailbox id from another workspace can never be used.
  const box = await dbOne(
    'SELECT id, address, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ? AND is_active = 1',
    [d.mailbox_id, d.workspace_id],
  );
  if (!box) return NextResponse.json({error: 'Mailbox not found for this workspace.'}, {status: 404});
  if (!(await canAccessMailbox(user.id, d.mailbox_id, true)))
    return NextResponse.json({error: 'No send permission on this mailbox.'}, {status: 403});

  // Server-side re-validation (never trust the client's preview).
  const suppressed = await loadSuppressionMap(d.workspace_id);
  const seen = new Set<string>();
  const valid: Array<{email: string; name: string; fields: Record<string, string>}> = [];
  const invalid: Array<{email: string; reason: string}> = [];
  let duplicatesRemoved = 0;
  let suppressedExcluded = 0;
  for (const r of d.recipients) {
    const email = r.email.trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      invalid.push({email: r.email, reason: !email ? 'missing_email' : 'invalid_email'});
      continue;
    }
    if (seen.has(email)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(email);
    if (suppressed.has(email)) {
      suppressedExcluded += 1;
      continue;
    }
    valid.push({email, name: (r.name || '').trim(), fields: r.fields || {}});
  }
  if (invalid.length > 0)
    return NextResponse.json(
      {error: `${invalid.length} recipient(s) have invalid or missing emails. Re-run the preview and fix them.`, invalid},
      {status: 400},
    );
  if (valid.length === 0)
    return NextResponse.json(
      {error: 'No valid recipients remain after validation (all invalid, duplicate, or suppressed).'},
      {status: 400},
    );
  if (valid.length > BULK_MAX_RECIPIENTS)
    return NextResponse.json(
      {error: `Too many recipients (${valid.length}). The per-campaign cap is ${BULK_MAX_RECIPIENTS}.`},
      {status: 400},
    );

  const campaignId = newId();
  const now = nowIso();
  await dbRun(
    `INSERT INTO bulk_campaigns (id, workspace_id, mailbox_id, created_by, name, subject, text_body, html_body, provider, status, total_recipients, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [campaignId, d.workspace_id, d.mailbox_id, user.id, d.name, d.subject, d.text, d.html, d.provider, valid.length, now, now],
  );
  for (const r of valid) {
    await dbRun(
      `INSERT INTO bulk_recipients (id, campaign_id, workspace_id, email, name, fields, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        newId(),
        campaignId,
        d.workspace_id,
        r.email,
        r.name,
        jstr(r.fields),
        bulkIdempotencyKey(campaignId, r.email),
        now,
        now,
      ],
    );
  }
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), d.workspace_id, user.id, 'bulk_campaign.created', 'bulk_campaign', campaignId, now],
  ).catch(() => {});
  const monthly = await monthlySendRemaining(d.workspace_id);
  const summary = await getBulkCampaignSummary(campaignId);
  return NextResponse.json({
    campaign: summary,
    duplicates_removed: duplicatesRemoved,
    suppressed_excluded: suppressedExcluded,
    monthly,
    monthly_warning:
      valid.length > monthly.remaining
        ? `This campaign has ${valid.length} recipients but only ${monthly.remaining} monthly sends remain for the workspace (limit ${monthly.limit}). It will pause when the limit is reached; resume next month.`
        : null,
  });
}
