// WorkMail AI agent — drafting + reply assistant.
//
// Provider (in priority order):
//   1. BYOK OpenAI-compatible provider, when AI_PROVIDER_API_KEY is set
//      (optional AI_PROVIDER_BASE_URL, AI_PROVIDER_MODEL).
//   2. Cloudflare Workers AI (free tier: 10,000 Neurons/day, no card),
//      using the host credentials already configured for D1/KV
//      (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN). The token must
//      carry Workers AI permission; a 403 from Cloudflare surfaces as a
//      clear "not configured" error, never as fake output.
//
// The manual names NO AI provider. The repo research note
// (docs/FREE-STACK-RESEARCH-2026-11-20.md) names Cloudflare Workers AI
// for lightweight assist features, with BYOK as an option — that is what
// is implemented here. No new API key is required for the default path.
//
// Guardrails (enforced here, not just documented):
// - Manual AI drafts NEVER send on their own. They only write drafts
//   (messages folder 'drafts') and review-queue entries; sending those
//   always goes through /api/send with a user session.
// - Auto-reply is the ONE transmission path: when the per-mailbox
//   auto-reply toggle is explicitly ON and the agent is configured,
//   `maybeAutoReply` actually TRANSMITS the reply via the internal
//   service send (lib/service-send.ts `executeServiceSend`) — the same
//   provider fallback engine, idempotency, suppression, caps, and
//   timeout=unknown rules as the user send path. Toggle OFF (or no
//   setting row, or AI unconfigured) = queue-only draft, no send.
// - Auto-send rate limits: max 1 auto-reply per inbound message
//   (deterministic idempotency key `ai-auto-reply:<messageId>`), and
//   never a second auto-reply to the same thread in a row — the first
//   auto-sent thread is recorded in KV and later inbound mail in that
//   thread is drafted + queued for human review only.
// - Prompts never include secrets, tokens, or provider credentials.
// - Message bodies are never written to logs. Logs carry only metadata:
//   prompt version, model, provider, mailbox id, message id, action.
// - Output is capped and truncated; the model is instructed never to
//   invent facts, dates, prices, or commitments, and to leave a
//   [NEEDS HUMAN INPUT] marker where it cannot know the answer.
// - Nothing is faked: when no provider is configured (or the provider
//   rejects the call), callers get {configured: false} / a 503 with a
//   clear message, and no draft text is invented.
import {createHash} from 'node:crypto';
import {dbRun, newId, nowIso} from '@/lib/db';
import {kvGet, kvPut} from '@/lib/kv';
import {executeServiceSend} from '@/lib/service-send';
import {buildTrainingContext} from '@/lib/ai-training';

export const AI_PROMPT_VERSION = 'v2';
export const AI_DEFAULT_WORKERS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const AI_MAX_INPUT_CHARS = 6000;
export const AI_MAX_OUTPUT_TOKENS = 800;

export type AiProviderKind = 'workers-ai' | 'byok';

export interface AiConfig {
  configured: boolean;
  provider: AiProviderKind | null;
  model: string;
  /** Human-readable reason when not configured. Never contains a secret. */
  reason: string;
}

export function aiConfig(): AiConfig {
  const byokKey = process.env.AI_PROVIDER_API_KEY || '';
  if (byokKey) {
    return {
      configured: true,
      provider: 'byok',
      model: process.env.AI_PROVIDER_MODEL || 'gpt-4o-mini',
      reason: '',
    };
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (account && token) {
    return {
      configured: true,
      provider: 'workers-ai',
      model: process.env.AI_MODEL || AI_DEFAULT_WORKERS_MODEL,
      reason: '',
    };
  }
  return {
    configured: false,
    provider: null,
    model: '',
    reason:
      'AI not configured — set AI_PROVIDER_API_KEY (BYOK OpenAI-compatible provider) ' +
      'or ensure CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set (Cloudflare Workers AI).',
  };
}

export class AiNotConfiguredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AiNotConfiguredError';
  }
}

export class AiProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
  }
}

const SYSTEM_PROMPT = [
  'You are WorkMail\'s email drafting assistant. You draft email text for a human to review before anything is sent.',
  'Rules:',
  '- Draft only what the user asked for. Never invent facts, dates, prices, order numbers, commitments, or meeting times.',
  '- If the answer needs a fact you do not have, write [NEEDS HUMAN INPUT] at that spot instead of guessing.',
  '- Keep the tone professional and concise. Do not add a sign-off with a person\'s name you were not given.',
  '- Never include passwords, tokens, API keys, or any credential in the draft.',
  '- Never claim the email has been sent, and never write anything that pretends to be a system or provider notice.',
  '- Reply in the same language as the incoming message (or the user\'s instruction).',
  `- Prompt version: ${AI_PROMPT_VERSION}.`,
].join('\n');

// --- Business training hook (lib/ai-training.ts) ---------------------------
// When the caller passes a workspace id (or a pre-built training block),
// the workspace's training is loaded and appended to the system prompt
// as a bounded block (max AI_TRAINING_MAX_CHARS, relevance-ranked, in the
// business's own voice). Training is workspace-scoped: only the given
// workspace's entries are ever read. Callers that pass neither get the
// plain base prompt — behaviour for existing callers is unchanged.
function buildSystemPrompt(trainingContext?: string): string {
  const block = (trainingContext || '').trim();
  if (!block) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    '\n\n' +
    block +
    '\nAnswer in the business\'s voice above (tone, do\'s and don\'ts). Use only the trained facts above; if the question needs a fact not in the training, write [NEEDS HUMAN INPUT] instead of guessing.'
  );
}

function truncate(s: string, max: number): string {
  const t = (s || '').trim();
  return t.length > max ? t.slice(0, max) + '\n[…truncated…]' : t;
}

async function callWorkersAi(cfg: AiConfig, userPrompt: string, systemPrompt: string): Promise<string> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  // The model name is part of the URL path with literal slashes
  // (@cf/meta/llama-...). encodeURIComponent turns the slashes into %2F,
  // which Cloudflare's router does not match ("No route for that URI").
  // Keep the model raw; fall back to the default when it is not a
  // well-formed Workers AI model id.
  const model = /^@cf\/[A-Za-z0-9._\/-]+$/.test(cfg.model) ? cfg.model : AI_DEFAULT_WORKERS_MODEL;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = j?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${r.status}`;
    throw new AiProviderError(
      `Cloudflare Workers AI rejected the request (${detail}). Check that the Cloudflare API token has Workers AI permission, or set AI_PROVIDER_API_KEY for a BYOK provider.`,
      r.status,
    );
  }
  const text = String(j?.result?.response || '').trim();
  if (!text) throw new AiProviderError('AI provider returned an empty response.', 502);
  return text;
}

async function callByok(cfg: AiConfig, userPrompt: string, systemPrompt: string): Promise<string> {
  const key = process.env.AI_PROVIDER_API_KEY || '';
  const base = (process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = j?.error?.message || `HTTP ${r.status}`;
    throw new AiProviderError(`AI provider rejected the request (${detail}).`, r.status);
  }
  const text = String(j?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new AiProviderError('AI provider returned an empty response.', 502);
  return text;
}

export interface GenerateDraftOptions {
  /** Load this workspace's training and inject it into the system prompt. */
  workspaceId?: string;
  /** Pre-built training block (takes precedence over loading by workspace). */
  trainingContext?: string;
  /** Inbound text used to rank training entries (defaults to the prompt). */
  inboundText?: string;
}

export interface TrainingUsage {
  /** Ids of the training entries injected (metadata only). */
  entryIds: string[];
  /** Characters of training text injected. */
  chars: number;
  /** Total training entries in the workspace. */
  totalEntries: number;
}

/** Generate raw draft text. Throws AiNotConfiguredError / AiProviderError. Never returns fake text.
 * When `opts.workspaceId` is given, the workspace's training is loaded
 * and injected into the system prompt (bounded, relevance-ranked); the
 * returned `trainingUsed` reports what was injected (metadata only). */
export async function generateDraftText(
  userPrompt: string,
  opts?: GenerateDraftOptions,
): Promise<{text: string; config: AiConfig; trainingUsed: TrainingUsage}> {
  const cfg = aiConfig();
  if (!cfg.configured) throw new AiNotConfiguredError(cfg.reason);
  let trainingContext = opts?.trainingContext || '';
  let trainingUsed: TrainingUsage = {entryIds: [], chars: 0, totalEntries: 0};
  if (!trainingContext && opts?.workspaceId) {
    try {
      const ctx = await buildTrainingContext(opts.workspaceId, opts.inboundText ?? userPrompt);
      trainingContext = ctx.context;
      trainingUsed = {entryIds: ctx.usedEntryIds, chars: ctx.chars, totalEntries: ctx.totalEntries};
    } catch {
      // Training load failure must never break drafting: fall back to the
      // plain base prompt (same behaviour as a workspace with no training).
      trainingContext = '';
      trainingUsed = {entryIds: [], chars: 0, totalEntries: 0};
    }
  } else if (trainingContext) {
    trainingUsed = {entryIds: [], chars: trainingContext.length, totalEntries: 0};
  }
  const systemPrompt = buildSystemPrompt(trainingContext);
  const text =
    cfg.provider === 'byok'
      ? await callByok(cfg, userPrompt, systemPrompt)
      : await callWorkersAi(cfg, userPrompt, systemPrompt);
  return {text, config: cfg, trainingUsed};
}

export function buildReplyPrompt(input: {
  from: string;
  subject: string;
  body: string;
  mailboxAddress: string;
  instruction?: string;
}): string {
  return [
    'Draft a reply to this incoming email.',
    `From: ${input.from}`,
    `Subject: ${truncate(input.subject, 200)}`,
    `Replying as mailbox: ${input.mailboxAddress}`,
    input.instruction ? `Sender instruction: ${truncate(input.instruction, 1000)}` : '',
    'Original message (truncated):',
    truncate(input.body, AI_MAX_INPUT_CHARS),
    'Write only the reply body, no subject line, no preamble.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildComposePrompt(input: {
  to: string;
  subject: string;
  instruction: string;
  mailboxAddress: string;
}): string {
  return [
    'Draft a new email from the instruction below.',
    `From mailbox: ${input.mailboxAddress}`,
    `To: ${input.to}`,
    `Subject: ${truncate(input.subject, 200)}`,
    `Instruction / points to cover: ${truncate(input.instruction, 4000)}`,
    'Write only the email body, no subject line, no preamble.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Persistence: drafts live in D1 (messages folder 'drafts', same shape as
// /api/drafts). Settings, review queue and AI logs live in KV under ai/*
// keys, so no schema change is needed. No message body is ever logged.
// ---------------------------------------------------------------------------

export interface AiDraftResult {
  draftId: string;
  to: string;
  subject: string;
  text: string;
  model: string;
  provider: AiProviderKind;
  promptVersion: string;
}

export async function saveAiDraft(input: {
  workspaceId: string;
  mailboxId: string;
  fromAddress: string;
  to: string;
  subject: string;
  text: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await dbRun(
    `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, delivery_state, received_at, created_at, updated_at)
     VALUES (?, ?, ?, 'drafts', ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.mailboxId,
      input.fromAddress,
      input.to,
      input.subject.slice(0, 998),
      input.text.slice(0, 100000),
      now,
      now,
      now,
    ],
  );
  return id;
}

/** Append-only AI action log in KV. Metadata only — never message bodies. */
export async function logAiAction(entry: {
  action: string;
  workspaceId: string;
  actorUserId?: string | null;
  mailboxId?: string | null;
  messageId?: string | null;
  draftId?: string | null;
  model?: string;
  provider?: string | null;
  /** Training usage metadata only (entry ids + count — never content). */
  training?: {count: number; entryIds: string[]};
}): Promise<void> {
  const now = nowIso();
  const day = now.slice(0, 10);
  const key = `ai:log/${entry.workspaceId}/${day}`;
  try {
    const raw = await kvGet(key);
    const list: any[] = raw ? JSON.parse(raw.toString('utf8')) : [];
    list.push({
      ts: now,
      action: entry.action,
      prompt_version: AI_PROMPT_VERSION,
      model: entry.model || null,
      provider: entry.provider || null,
      mailbox_id: entry.mailboxId || null,
      message_id: entry.messageId || null,
      draft_id: entry.draftId || null,
      actor_user_id: entry.actorUserId || null,
      // Training usage: metadata only (entry ids + count, never content).
      training_used: entry.training
        ? {count: entry.training.count, entry_ids: entry.training.entryIds}
        : null,
    });
    // Keep the log bounded: last 200 entries per workspace-day.
    const trimmed = list.slice(-200);
    await kvPut(key, Buffer.from(JSON.stringify(trimmed), 'utf8'), 'application/json');
  } catch {
    // Logging must never break drafting. Swallow (no body involved).
  }
  // Mirror the action (ids only, no bodies) into the existing audit trail.
  try {
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), entry.workspaceId, entry.actorUserId || null, entry.action, 'message', entry.draftId || entry.messageId || null, now],
    );
  } catch {
    // Audit mirroring is best-effort; the KV log above is the primary record.
  }
}

// --- Auto-reply settings (per mailbox; absent = OFF) ------------------------

export interface AutoReplySetting {
  enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export async function getAutoReplySetting(mailboxId: string): Promise<AutoReplySetting> {
  try {
    const raw = await kvGet(`ai:auto-reply/${mailboxId}`);
    if (!raw) return {enabled: false, updated_at: null, updated_by: null};
    const j = JSON.parse(raw.toString('utf8'));
    return {enabled: j.enabled === true, updated_at: j.updated_at || null, updated_by: j.updated_by || null};
  } catch {
    return {enabled: false, updated_at: null, updated_by: null};
  }
}

export async function setAutoReplySetting(
  mailboxId: string,
  enabled: boolean,
  updatedBy: string,
): Promise<AutoReplySetting> {
  const setting: AutoReplySetting = {enabled, updated_at: nowIso(), updated_by: updatedBy};
  await kvPut(`ai:auto-reply/${mailboxId}`, Buffer.from(JSON.stringify(setting), 'utf8'), 'application/json');
  return setting;
}

// --- Human-review queue (per workspace, KV JSON array) ----------------------
// Queue entries point at drafts-folder messages. Status flow:
//   pending (needs human review) -> approved (human confirmed, ready to send
//   via /api/send) | discarded. `auto: true` means the draft was generated
//   by the inbound auto-reply path while the toggle was ON. `sent` means
//   the reply was actually transmitted — either by a human Send via
//   /api/send (marked from the UI) or by the auto-send path in
//   `maybeAutoReply` (marked here, with `provider` + `sent_at`).

export interface ReviewQueueItem {
  draft_id: string;
  source_message_id: string | null;
  mailbox_id: string;
  to: string;
  subject: string;
  auto: boolean;
  status: 'pending' | 'approved' | 'sent' | 'discarded';
  created_at: string;
  /** Provider that transmitted the reply (auto-send or human Send). */
  provider?: string | null;
  /** ISO timestamp the reply was transmitted. */
  sent_at?: string | null;
}

export async function getReviewQueue(workspaceId: string): Promise<ReviewQueueItem[]> {
  try {
    const raw = await kvGet(`ai:queue/${workspaceId}`);
    if (!raw) return [];
    const list = JSON.parse(raw.toString('utf8'));
    return Array.isArray(list) ? (list as ReviewQueueItem[]) : [];
  } catch {
    return [];
  }
}

export async function addToReviewQueue(workspaceId: string, item: ReviewQueueItem): Promise<void> {
  const list = await getReviewQueue(workspaceId);
  list.unshift(item);
  await kvPut(`ai:queue/${workspaceId}`, Buffer.from(JSON.stringify(list.slice(0, 200)), 'utf8'), 'application/json');
}

export async function updateQueueItem(
  workspaceId: string,
  draftId: string,
  status: ReviewQueueItem['status'],
  patch?: Partial<Pick<ReviewQueueItem, 'provider' | 'sent_at'>>,
): Promise<ReviewQueueItem | null> {
  const list = await getReviewQueue(workspaceId);
  const item = list.find((q) => q.draft_id === draftId);
  if (!item) return null;
  item.status = status;
  if (patch?.provider !== undefined) item.provider = patch.provider;
  if (patch?.sent_at !== undefined) item.sent_at = patch.sent_at;
  await kvPut(`ai:queue/${workspaceId}`, Buffer.from(JSON.stringify(list.slice(0, 200)), 'utf8'), 'application/json');
  return item;
}

// --- Auto-send rate limits (per mailbox) ------------------------------------
// Two guards, both metadata-only (no bodies in KV):
//   1. One auto-reply per inbound message: the send itself carries the
//      deterministic idempotency key `ai-auto-reply:<messageId>`, so a
//      retried inbound can never double-send (the send path returns the
//      duplicate instead).
//   2. Never a second auto-reply to the same thread in a row: after an
//      auto-send (accepted, or `unknown` — which may still have been
//      delivered), the thread is recorded in KV. Later inbound mail in
//      that thread is still drafted + queued for human review, but is
//      NOT auto-sent. A thread is one sender + one normalised subject
//      (Re:/Fwd: prefixes stripped, lower-cased).
function normalizeThreadSubject(subject: string): string {
  let s = (subject || '').toLowerCase().trim();
  for (;;) {
    const m = /^(re|fwd|fw)\s*:\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length).trim();
  }
  return s;
}

export function autoReplyThreadKey(from: string, subject: string): string {
  return createHash('sha256').update(`${from.toLowerCase()}|${normalizeThreadSubject(subject)}`).digest('hex');
}

interface AutoReplyThreadMarker {
  source_message_id: string;
  draft_id: string;
  provider: string | null;
  sent_at: string;
}

async function getThreadMarker(mailboxId: string, threadKey: string): Promise<AutoReplyThreadMarker | null> {
  try {
    const raw = await kvGet(`ai:auto-reply-thread/${mailboxId}/${threadKey}`);
    if (!raw) return null;
    return JSON.parse(raw.toString('utf8')) as AutoReplyThreadMarker;
  } catch {
    return null;
  }
}

async function setThreadMarker(
  mailboxId: string,
  threadKey: string,
  marker: AutoReplyThreadMarker,
): Promise<void> {
  try {
    await kvPut(
      `ai:auto-reply-thread/${mailboxId}/${threadKey}`,
      Buffer.from(JSON.stringify(marker), 'utf8'),
      'application/json',
    );
  } catch {
    // Marker write failure must not break the send that already happened.
  }
}

// --- Inbound auto-reply hook -------------------------------------------------
// Automated / bounce senders an AI auto-reply must NEVER transmit to
// (2026-11-22: four replies went to provider bounce addresses because
// the worker passed the SMTP envelope sender as the From). Such mail is
// not drafted or sent at all — the human reads it in the inbox.
const AUTO_REPLY_BLOCKED_DOMAINS = ['sender-sib.com', 'bnc3.mailjet.com', 'gaia.bounces.google.com', 'amazonses.com'];
function isAutomatedSender(addr: string): boolean {
  const a = addr.toLowerCase().trim();
  const local = a.split('@')[0] || '';
  const domain = a.split('@')[1] || '';
  if (local.startsWith('bounces-') || local.startsWith('bounce-')) return true;
  if (['mailer-daemon', 'postmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply'].includes(local)) return true;
  if (local.includes('bounce') || domain.includes('bounce')) return true;
  return AUTO_REPLY_BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}
// Plain text from an HTML body when the plain-text part is empty
// (provider-sent mail is often HTML-only; the model answered "I can't
// find any information" on an empty body, 2026-11-22).
function plainTextFromHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
// The model is told to write [NEEDS HUMAN INPUT] instead of guessing,
// but nothing ever checked the output before transmitting (2026-11-22:
// "I'm not able to find any information about the original message…"
// was sent as-is). A draft that is not a real answer is queued for
// human review, never transmitted.
const NON_ANSWER_PATTERNS = [
  'needs human input',
  'not able to find any information',
  'unable to find any information',
  "i don't have enough information",
  'i do not have enough information',
  'please provide more context',
  'could you provide more',
  'need more information',
  'more details are needed',
];
function looksLikeNonAnswer(text: string): boolean {
  const t = text.toLowerCase();
  return NON_ANSWER_PATTERNS.some((p) => t.includes(p));
}

// Called by /api/inbound after a message is stored. NEVER throws: any
// failure is swallowed by the caller so inbound delivery is unaffected.
// Behaviour:
//   - Toggle OFF (or no setting row) -> nothing happens.
//   - Toggle ON + AI configured -> an AI reply draft is generated, saved
//     to drafts, and queued (auto: true, status pending). Then, unless
//     the thread guard blocks it, the reply is actually TRANSMITTED via
//     the internal service send (`executeServiceSend` — same provider
//     fallback engine, idempotency, suppression, caps, and
//     timeout=unknown rules as /api/send) and the queue entry is marked
//     `sent` with provider + timestamp.
//   - Thread already auto-replied (or mail from the mailbox itself) ->
//     draft + queue only, no transmission (human review can still send).
//   - Automated / bounce senders (provider Return-Path addresses) and
//     any of the workspace's own mailboxes -> nothing is drafted or
//     sent (2026-11-22: four replies went to bounce addresses because
//     the worker passed the SMTP envelope sender as the From).
//   - Empty body (HTML-only mail with no plain-text part) -> nothing
//     is drafted or sent; the mail waits in the inbox for a human.
//   - Generated text that is not a real answer ([NEEDS HUMAN INPUT]
//     or a "can't find any information" style reply) -> drafted +
//     queued only, never transmitted.
//   - Toggle ON + AI not configured / provider error -> no draft, no fake
//     reply; the failure is logged (metadata only) and the inbound mail
//     itself is unaffected.
//   - Send outcome `unknown` (provider timeout): the queue entry stays
//     pending and the thread is still marked, so nothing blindly resends
//     — reconciliation happens via /api/ops/reconcile, as on the user
//     path. A definitive failure/suppression leaves the entry pending
//     for human review and does not mark the thread.
export async function maybeAutoReply(input: {
  workspaceId: string;
  mailboxId: string;
  mailboxAddress: string;
  messageId: string;
  from: string;
  /** MIME Reply-To header (the real reply target); falls back to `from`. */
  replyTo?: string;
  /** HTML body, used for a plain-text fallback when `body` is empty. */
  html?: string;
  /** All of the workspace's mailbox addresses (own-mail skip). */
  ownAddresses?: string[];
  subject: string;
  body: string;
}): Promise<{drafted: boolean; draftId?: string; sent?: boolean; provider?: string | null; reason?: string}> {
  try {
    const setting = await getAutoReplySetting(input.mailboxId);
    if (!setting.enabled) return {drafted: false, reason: 'auto-reply off'};
    // Reply target: the MIME Reply-To header when present, else the
    // header From. The SMTP envelope sender (Return-Path) is a bounce
    // address for provider-sent mail and must never be replied to.
    const replyTarget = (input.replyTo || input.from).trim();
    // Never draft or send to automated / bounce addresses, and never
    // to any of the workspace's own mailboxes (loop protection,
    // stronger than the old single-mailbox check).
    const own = new Set((input.ownAddresses || [input.mailboxAddress]).map((a) => a.toLowerCase()));
    if (isAutomatedSender(replyTarget) || own.has(replyTarget.toLowerCase()))
      return {drafted: false, reason: 'automated-or-own-sender'};
    // Plain-text fallback: provider-sent mail is often HTML-only, and
    // the model answered "I can't find any information" on an empty
    // body (2026-11-22). Still empty -> wait for a human.
    const effectiveBody = input.body?.trim() ? input.body : input.html ? plainTextFromHtml(input.html) : '';
    if (!effectiveBody.trim()) return {drafted: false, reason: 'empty-body'};
    const cfg = aiConfig();
    if (!cfg.configured) return {drafted: false, reason: 'ai-not-configured'};
    const threadKey = autoReplyThreadKey(replyTarget, input.subject);
    const threadBlocked = (await getThreadMarker(input.mailboxId, threadKey)) !== null;
    let text: string;
    let trainingUsed: TrainingUsage = {entryIds: [], chars: 0, totalEntries: 0};
    try {
      // Training hook: the workspace's business training is loaded and
      // injected into the system prompt, ranked by relevance to this
      // inbound message — so auto-replies answer in the business's voice
      // using its own facts. A training-load failure falls back to the
      // plain prompt (generateDraftText handles it); drafting continues.
      const out = await generateDraftText(
        buildReplyPrompt({
          from: replyTarget,
          subject: input.subject,
          body: effectiveBody,
          mailboxAddress: input.mailboxAddress,
        }),
        {workspaceId: input.workspaceId, inboundText: `${input.subject}\n${effectiveBody}`},
      );
      text = out.text;
      trainingUsed = out.trainingUsed;
    } catch (e) {
      await logAiAction({
        action: 'ai.auto_reply_failed',
        workspaceId: input.workspaceId,
        actorUserId: null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        draftId: null,
        model: cfg.model,
        provider: cfg.provider,
      });
      return {drafted: false, reason: e instanceof Error ? e.message : 'ai-provider-error'};
    }
    const subject = input.subject.startsWith('Re: ') ? input.subject : `Re: ${input.subject || '(No Subject)'}`;
    const draftId = await saveAiDraft({
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      fromAddress: input.mailboxAddress,
      to: replyTarget,
      subject,
      text,
    });
    await addToReviewQueue(input.workspaceId, {
      draft_id: draftId,
      source_message_id: input.messageId,
      mailbox_id: input.mailboxId,
      to: replyTarget,
      subject,
      auto: true,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    await logAiAction({
      action: 'ai.auto_reply_drafted',
      workspaceId: input.workspaceId,
      actorUserId: null,
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      draftId,
      model: cfg.model,
      provider: cfg.provider,
      training: {count: trainingUsed.entryIds.length, entryIds: trainingUsed.entryIds},
    });
    if (threadBlocked || looksLikeNonAnswer(text)) {
      // Drafted + queued for human review, but NOT transmitted: either
      // this thread already received one auto-reply, or the generated
      // text is not a real answer (2026-11-22: a confused "I can't
      // find any information" draft was transmitted as-is).
      return {
        drafted: true,
        draftId,
        sent: false,
        reason: threadBlocked ? 'thread-already-auto-replied' : 'non-answer-draft',
      };
    }
    // Transmit via the service send path. Deterministic idempotency key
    // = max 1 auto-reply per inbound message, even on retry.
    let exec;
    try {
      exec = await executeServiceSend({
        workspaceId: input.workspaceId,
        mailboxId: input.mailboxId,
        to: replyTarget,
        subject,
        text,
        idempotencyKey: `ai-auto-reply:${input.messageId}`,
      });
    } catch {
      await logAiAction({
        action: 'ai.auto_reply_send_failed',
        workspaceId: input.workspaceId,
        actorUserId: null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        draftId,
        model: cfg.model,
        provider: cfg.provider,
      });
      return {drafted: true, draftId, sent: false, reason: 'send-error'};
    }
    if (exec.outcome === 'accepted' || exec.outcome === 'duplicate') {
      const sentAt = new Date().toISOString();
      await updateQueueItem(input.workspaceId, draftId, 'sent', {
        provider: exec.provider,
        sent_at: sentAt,
      });
      await setThreadMarker(input.mailboxId, threadKey, {
        source_message_id: input.messageId,
        draft_id: draftId,
        provider: exec.provider,
        sent_at: sentAt,
      });
      await logAiAction({
        action: 'ai.auto_reply_sent',
        workspaceId: input.workspaceId,
        actorUserId: null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        draftId,
        model: cfg.model,
        provider: exec.provider,
      });
      return {drafted: true, draftId, sent: true, provider: exec.provider};
    }
    if (exec.outcome === 'unknown') {
      // Outcome unknown: the provider may have delivered. Mark the
      // thread so nothing resends blindly; the queue entry stays pending
      // and /api/ops/reconcile resolves the ambiguity.
      await setThreadMarker(input.mailboxId, threadKey, {
        source_message_id: input.messageId,
        draft_id: draftId,
        provider: exec.provider,
        sent_at: new Date().toISOString(),
      });
      await logAiAction({
        action: 'ai.auto_reply_send_unknown',
        workspaceId: input.workspaceId,
        actorUserId: null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        draftId,
        model: cfg.model,
        provider: exec.provider,
      });
      return {drafted: true, draftId, sent: false, reason: 'send-unknown'};
    }
    // Definitive failure / suppression / rejection: no transmission, no
    // thread mark. The draft stays queued for human review.
    await logAiAction({
      action: 'ai.auto_reply_send_failed',
      workspaceId: input.workspaceId,
      actorUserId: null,
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      draftId,
      model: cfg.model,
      provider: cfg.provider,
    });
    return {drafted: true, draftId, sent: false, reason: exec.outcome === 'suppressed' ? 'send-suppressed' : 'send-failed'};
  } catch {
    return {drafted: false, reason: 'internal-error'};
  }
}
