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
  BULK_UNSUPPLIABLE_VARIABLES,
  bulkIdempotencyKey,
  extractPlaceholders,
  getBulkCampaignSummary,
  isDisposableDomain,
  isValidEmail,
  loadSuppressionMap,
  monthlySendRemaining,
  validateBulkAttachments,
} from '@/lib/bulk';
import {extractTemplateVariables, getTemplate} from '@/lib/templates';

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
    subject: z.string().max(998).optional().default(''),
    text: z.string().max(100000).optional().default(''),
    html: z.string().max(200000).optional().default(''),
    recipients: z.array(recipientSchema).min(1).max(BULK_MAX_RECIPIENTS),
    // Per-campaign provider choice (F3): 'auto' = fallback chain, or one
    // provider name = ONLY that provider, no silent fallback (enforced
    // in the send engine). Stored on the campaign row.
    provider: z.enum(['auto', 'sendpulse', 'brevo', 'mailjet', 'resend']).optional().default('auto'),
    // Template to render per recipient at send time (Phase 1). When set,
    // the campaign's stored text/html are the creation-time snapshot;
    // the runner renders the template row instead. Subject still comes
    // from the request (defaults to the template subject when empty).
    template_id: z.string().uuid().optional(),
    // Bulk v2 (E3): true = per-recipient rendering ({{name}}, {{email}},
    // CSV columns); false = SAME, one identical body for everyone.
    // Default true preserves the pre-v2 behaviour (always rendered
    // per recipient).
    personalized: z.boolean().optional().default(true),
    // Bulk v2 (E5-5): one attachment set per campaign, uploaded via
    // POST /api/attachments first (object_key form — KV key prefix
    // proves ownership). Caps enforced below (2 MB/file, 1 MB total).
    attachments: z
      .array(
        z.object({
          object_key: z.string().max(500).optional(),
          attachment_id: z.string().optional(),
          file_name: z.string().max(200).optional(),
          content_type: z.string().max(100).optional(),
          size_bytes: z.number().int().nonnegative().optional(),
        }),
      )
      .max(10)
      .optional()
      .default([]),
  })
  .refine((x) => !!(x.text || x.html || x.template_id), {message: 'Provide a text body, an HTML body, or a template.'})
  .refine((x) => !!(x.subject || x.template_id), {message: 'Provide a subject, or pick a template that has one.'});

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

  // Bulk v2 (E5-5): one attachment set per campaign — 2 MB/file,
  // 1 MB total per message (SendPulse free-tier cap). Rejected here,
  // before any recipient is stored, so a bad set never creates a
  // campaign that fails every recipient at send time.
  if (d.attachments.length > 0) {
    const attCheck = validateBulkAttachments(d.attachments, d.workspace_id, d.mailbox_id);
    if (!attCheck.ok) return NextResponse.json({error: attCheck.error}, {status: 413});
  }

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
    // Bulk v2 (E3): disposable/temp-mail domains are rejected at parse
    // (interim blocklist in lib/bulk.ts; Phase 3b G-12 centralises it).
    if (isDisposableDomain(email)) {
      invalid.push({email: r.email, reason: 'disposable_domain'});
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
  // Variables any recipient can supply: email/name, the automatic
  // sender_name/unsubscribe_url, and the union of the recipients' CSV
  // columns. In SAME mode (personalized=false) only the automatic
  // ones are allowed — a per-recipient value cannot be the same for
  // everyone, so it is rejected here instead of failing every
  // recipient at send time.
  const knownManual = new Set<string>(['email', 'name', 'sender_name', 'unsubscribe_url']);
  if (d.personalized) {
    for (const r of d.recipients) for (const k of Object.keys(r.fields || {})) knownManual.add(k.toLowerCase());
  } else {
    knownManual.delete('email');
    knownManual.delete('name');
  }
  // Template validation (Phase 1): the template must belong to this
  // workspace, and every variable it uses must be suppliable per
  // recipient (a sheet column, email/name, or the automatic
  // sender_name/unsubscribe_url). {{otp}} / {{action_url}} have no
  // per-recipient value in bulk, so a campaign using them is rejected
  // here — not one failed recipient at a time at send time.
  let templateSubject = '';
  if (d.template_id) {
    const template = await getTemplate(d.workspace_id, d.template_id);
    if (!template)
      return NextResponse.json({error: 'Template not found for this workspace.'}, {status: 404});
    templateSubject = template.subject;
    const known = new Set<string>(['email', 'name', 'sender_name', 'unsubscribe_url']);
    for (const r of d.recipients) for (const k of Object.keys(r.fields || {})) known.add(k.toLowerCase());
    const needed = [
      ...new Set([...extractTemplateVariables(template.subject), ...extractTemplateVariables(template.html_body), ...extractTemplateVariables(template.text_body)]),
    ];
    const missing = needed.filter((v) => !known.has(v));
    if (missing.length > 0)
      return NextResponse.json(
        {
          error: `This template uses variable(s) a bulk campaign cannot supply: ${missing.map((v) => `{{${v}}}`).join(', ')}. Pick a template that only uses recipient columns, {{name}}, {{email}}, {{sender_name}} and {{unsubscribe_url}}.`,
        },
        {status: 400},
      );
    // Bulk v2: a SAME campaign cannot use a template with per-recipient
    // variables — the rendered copy would differ per recipient.
    if (!d.personalized) {
      const perRecipient = needed.filter((v) => v !== 'sender_name' && v !== 'unsubscribe_url');
      if (perRecipient.length > 0)
        return NextResponse.json(
          {
            error: `SAME mode sends one identical message to everyone, but this template uses per-recipient variable(s): ${perRecipient.map((v) => `{{${v}}}`).join(', ')}. Switch to Personalized, or pick a template without them.`,
          },
          {status: 400},
        );
    }
  } else {
    // Bulk v2: manual messages get the same strict rule as templates.
    // {{otp}} / {{action_url}} can never be supplied in bulk; any other
    // variable must be a recipient column (personalized) or an automatic
    // value (SAME). Rejected at creation — not one failed recipient at
    // a time at send time. (The runner still renders strictly as
    // defence in depth: a variable valid for one recipient's columns
    // but not another's fails that recipient honestly.)
    const needed = [
      ...new Set([
        ...extractPlaceholders(d.subject),
        ...extractPlaceholders(d.text),
        ...extractPlaceholders(d.html),
      ]),
    ];
    const unsuppliable = needed.filter((v) =>
      (BULK_UNSUPPLIABLE_VARIABLES as readonly string[]).includes(v),
    );
    if (unsuppliable.length > 0)
      return NextResponse.json(
        {
          error: `This message uses variable(s) a bulk campaign cannot supply: ${unsuppliable.map((v) => `{{${v}}}`).join(', ')}. Remove them from the subject/body.`,
        },
        {status: 400},
      );
    const missing = needed.filter((v) => !knownManual.has(v));
    if (missing.length > 0)
      return NextResponse.json(
        {
          error: d.personalized
            ? `This message uses variable(s) no recipient supplies: ${missing.map((v) => `{{${v}}}`).join(', ')}. Add the column to your list, or remove the variable.`
            : `SAME mode sends one identical message to everyone, but this message uses per-recipient variable(s): ${missing.map((v) => `{{${v}}}`).join(', ')}. Switch to Personalized, or remove them.`,
        },
        {status: 400},
      );
  }
  const subject = d.subject.trim() ? d.subject : templateSubject;
  if (!subject)
    return NextResponse.json({error: 'Provide a subject (or pick a template that has one).'}, {status: 400});
  await dbRun(
    `INSERT INTO bulk_campaigns (id, workspace_id, mailbox_id, created_by, name, subject, text_body, html_body, provider, template_id, personalized, attachments, status, total_recipients, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [campaignId, d.workspace_id, d.mailbox_id, user.id, d.name, subject, d.text, d.html, d.provider, d.template_id || null, d.personalized ? 1 : 0, JSON.stringify(d.attachments), valid.length, now, now],
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
