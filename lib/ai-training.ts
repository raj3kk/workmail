// WorkMail AI training — "Train AI agent for your business".
//
// The owner teaches the agent about their business (profile, products /
// services, FAQs, tone & style, do's and don'ts, sample replies) by
// pasting text or uploading .txt / .md / .csv files. The agent then uses
// that knowledge when drafting replies and sending mail (auto-reply
// included): the training hook in lib/ai.ts loads the workspace's
// training and injects a compact, relevance-ranked slice of it into the
// system prompt, in the business's own voice.
//
// Storage (no schema change, no new dependency):
//   KV `ai:training/<workspaceId>/entries` — one JSON array (max 100
//   entries) holding the whole workspace training set, following the
//   existing single-key JSON-array pattern of `ai:queue/<workspaceId>`
//   in lib/ai.ts. One key keeps reads to a single KV fetch per draft
//   and avoids key enumeration (this KV helper has no list API).
//   Workspace-scoped by construction: the key embeds the workspace id,
//   every route checks workspace membership, and retrieval only ever
//   reads the caller's own workspace key — another tenant's training
//   can never leak into a prompt.
//
// Secrets: training text itself is NOT a secret, but provider keys and
// credentials must never be stored as training. Every create/update
// (and every uploaded chunk) is scanned by `findSecretInText`; a match
// is rejected with a clear error naming the pattern — the matched value
// is never echoed back or logged.
//
// Retrieval: `selectTrainingEntries` is pure (no KV, no network) so it
// is unit-testable. Profile / tone / rule entries are always included
// first (they define the voice); FAQ / product / sample-reply /
// document entries are ranked by keyword overlap with the inbound
// message and the top ones fill the remaining budget. Injected training
// text is capped at AI_TRAINING_MAX_CHARS (4,000) so prompts stay
// bounded. Only metadata is logged (entry ids + counts, never content).
import {kvGet, kvPut} from '@/lib/kv';
import {newId, nowIso} from '@/lib/db';

export const AI_TRAINING_MAX_CHARS = 4000;
export const AI_TRAINING_MAX_ENTRY_CHARS = 20000;
export const AI_TRAINING_MAX_ENTRIES = 100;
export const AI_TRAINING_MAX_UPLOAD_ENTRIES = 50;
export const AI_TRAINING_MAX_UPLOAD_CHARS = 200000;

export type TrainingKind =
  | 'profile'
  | 'product'
  | 'faq'
  | 'tone'
  | 'rule'
  | 'sample_reply'
  | 'document';

export const TRAINING_KINDS: TrainingKind[] = [
  'profile',
  'product',
  'faq',
  'tone',
  'rule',
  'sample_reply',
  'document',
];

export interface TrainingEntry {
  id: string;
  kind: TrainingKind;
  /** Short label — for FAQs this is the question. */
  title: string;
  /** Body — for FAQs this is the answer. */
  content: string;
  source: 'paste' | 'upload';
  filename: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingInput {
  kind: TrainingKind;
  title: string;
  content: string;
  source?: 'paste' | 'upload';
  filename?: string | null;
}

export function trainingKey(workspaceId: string): string {
  return `ai:training/${workspaceId}/entries`;
}

// --- Secret scan -----------------------------------------------------------
// Patterns that look like a provider key / credential. The error names the
// pattern only; the matched value is never returned, logged, or stored.
const SECRET_PATTERNS: Array<{name: string; re: RegExp}> = [
  {name: 'OpenAI-style API key (sk-…)', re: /sk-[A-Za-z0-9]{20,}/},
  {name: 'GitHub token (ghp_… / github_pat_…)', re: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/},
  {name: 'AWS access key (AKIA…)', re: /AKIA[0-9A-Z]{16}/},
  {name: 'Slack token (xox…)', re: /xox[baprs]-[A-Za-z0-9-]{10,}/},
  {name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/},
  {name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/},
  {
    name: 'API key / secret assignment',
    re: /(api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  },
  {
    name: 'Password assignment',
    re: /password\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  },
];

/** Name of the first secret pattern found in `text`, or null. Pure. */
export function findSecretInText(text: string): string | null {
  const s = text || '';
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(s)) return p.name;
  }
  return null;
}

export class TrainingSecretError extends Error {
  pattern: string;
  constructor(pattern: string) {
    super(
      `Training text looks like it contains a credential (${pattern}). ` +
        'Never store API keys, tokens, passwords, or private keys as training data — remove it and try again.',
    );
    this.name = 'TrainingSecretError';
    this.pattern = pattern;
  }
}

function validateEntryText(title: string, content: string): void {
  const secret = findSecretInText(`${title}\n${content}`);
  if (secret) throw new TrainingSecretError(secret);
}

// --- CRUD (KV, workspace-scoped) -------------------------------------------

export async function listTraining(workspaceId: string): Promise<TrainingEntry[]> {
  try {
    const raw = await kvGet(trainingKey(workspaceId));
    if (!raw) return [];
    const list = JSON.parse(raw.toString('utf8'));
    return Array.isArray(list) ? (list as TrainingEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveTraining(workspaceId: string, entries: TrainingEntry[]): Promise<void> {
  await kvPut(
    trainingKey(workspaceId),
    Buffer.from(JSON.stringify(entries.slice(0, AI_TRAINING_MAX_ENTRIES)), 'utf8'),
    'application/json',
  );
}

export async function createTrainingEntry(
  workspaceId: string,
  input: TrainingInput,
  createdBy: string | null,
): Promise<TrainingEntry> {
  const title = (input.title || '').trim().slice(0, 200);
  const content = (input.content || '').trim().slice(0, AI_TRAINING_MAX_ENTRY_CHARS);
  if (!title) throw new Error('Training entry needs a title.');
  if (!content) throw new Error('Training entry needs content.');
  validateEntryText(title, content);
  const entries = await listTraining(workspaceId);
  if (entries.length >= AI_TRAINING_MAX_ENTRIES)
    throw new Error(`Training limit reached (${AI_TRAINING_MAX_ENTRIES} entries per workspace). Delete an entry first.`);
  const now = nowIso();
  const entry: TrainingEntry = {
    id: newId(),
    kind: input.kind,
    title,
    content,
    source: input.source || 'paste',
    filename: input.filename || null,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };
  entries.push(entry);
  await saveTraining(workspaceId, entries);
  return entry;
}

export async function updateTrainingEntry(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<TrainingInput, 'kind' | 'title' | 'content'>>,
): Promise<TrainingEntry | null> {
  const entries = await listTraining(workspaceId);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 200) : entry.title;
  const content =
    patch.content !== undefined
      ? patch.content.trim().slice(0, AI_TRAINING_MAX_ENTRY_CHARS)
      : entry.content;
  if (!title || !content) throw new Error('Training entry needs a title and content.');
  validateEntryText(title, content);
  entry.title = title;
  entry.content = content;
  if (patch.kind) entry.kind = patch.kind;
  entry.updated_at = nowIso();
  await saveTraining(workspaceId, entries);
  return entry;
}

export async function deleteTrainingEntry(workspaceId: string, id: string): Promise<boolean> {
  const entries = await listTraining(workspaceId);
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  await saveTraining(workspaceId, kept);
  return true;
}

/**
 * Add several parsed entries in one KV read + one KV write (used for
 * file uploads). Validates every entry first — if any chunk looks like a
 * credential, nothing is stored and TrainingSecretError is thrown.
 */
export async function addTrainingEntries(
  workspaceId: string,
  inputs: TrainingInput[],
  createdBy: string | null,
): Promise<TrainingEntry[]> {
  const cleaned = inputs.map((input) => ({
    kind: input.kind,
    title: (input.title || '').trim().slice(0, 200),
    content: (input.content || '').trim().slice(0, AI_TRAINING_MAX_ENTRY_CHARS),
    source: input.source || ('upload' as const),
    filename: input.filename || null,
  }));
  for (const c of cleaned) {
    if (!c.title || !c.content) throw new Error('Every training entry needs a title and content.');
    validateEntryText(c.title, c.content);
  }
  const entries = await listTraining(workspaceId);
  if (entries.length + cleaned.length > AI_TRAINING_MAX_ENTRIES)
    throw new Error(
      `Training limit is ${AI_TRAINING_MAX_ENTRIES} entries per workspace (${entries.length} stored, ${cleaned.length} in this upload). Delete entries first.`,
    );
  const now = nowIso();
  const created: TrainingEntry[] = cleaned.map((c) => ({
    id: newId(),
    kind: c.kind,
    title: c.title,
    content: c.content,
    source: c.source,
    filename: c.filename,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  }));
  entries.push(...created);
  await saveTraining(workspaceId, entries);
  return created;
}

// --- Upload parsing (server-side, no new deps) -----------------------------
// .txt / .md: split on headings (# ...) or blank lines into chunks.
// .csv: header row detected when it names question/answer (or q/a, or
// title/content) columns; otherwise each row is one entry (first cell =
// title, rest joined = content). A single-column CSV is one entry per row.

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function chunkText(text: string, maxChars: number): string[] {
  // Split on headings first, then on blank lines; oversized pieces are
  // hard-split so no chunk ever exceeds the cap.
  const parts = text
    .split(/(?=^#{1,3}\s)/m)
    .flatMap((p) => p.split(/\n\s*\n/))
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.length <= maxChars) {
      chunks.push(p);
    } else {
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
    }
  }
  return chunks;
}

export interface ParsedUploadEntry {
  kind: TrainingKind;
  title: string;
  content: string;
}

/**
 * Parse pasted/uploaded file text into training entries. Pure — no KV.
 * Throws TrainingSecretError if any chunk looks like a credential, or a
 * plain Error when the file has no usable text. Never returns the secret.
 */
export function parseUploadedTraining(text: string, filename: string): ParsedUploadEntry[] {
  const clean = (text || '').replace(/^\uFEFF/, '').trim();
  if (!clean) throw new Error('Uploaded file is empty.');
  if (clean.length > AI_TRAINING_MAX_UPLOAD_CHARS)
    throw new Error(
      `Uploaded file is too large (${clean.length} characters; max ${AI_TRAINING_MAX_UPLOAD_CHARS}). Split it into smaller files.`,
    );
  const lower = (filename || '').toLowerCase();
  const out: ParsedUploadEntry[] = [];
  const push = (kind: TrainingKind, title: string, content: string) => {
    const t = (title || '').trim().slice(0, 200);
    const c = (content || '').trim().slice(0, AI_TRAINING_MAX_ENTRY_CHARS);
    if (!t || !c) return;
    const secret = findSecretInText(`${t}\n${c}`);
    if (secret) throw new TrainingSecretError(secret);
    out.push({kind, title: t, content: c});
  };

  if (lower.endsWith('.csv')) {
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) throw new Error('Uploaded file is empty.');
    const first = splitCsvLine(lines[0]).map((c) => c.toLowerCase());
    const qIdx = first.findIndex((c) => ['question', 'q', 'title', 'faq'].includes(c));
    const aIdx = first.findIndex((c) => ['answer', 'a', 'content', 'response', 'reply'].includes(c));
    const hasHeader = qIdx >= 0 && aIdx >= 0;
    const rows = (hasHeader ? lines.slice(1) : lines).map(splitCsvLine);
    for (const row of rows) {
      if (hasHeader) {
        push('faq', row[qIdx] || '', row[aIdx] || '');
      } else if (row.length >= 2) {
        push('faq', row[0], row.slice(1).join(' '));
      } else {
        push('document', row[0].slice(0, 80), row[0]);
      }
    }
  } else {
    // .txt / .md (and anything else treated as plain text).
    const chunks = chunkText(clean, 4000);
    const base = (filename || 'pasted-text').replace(/\.[^.]+$/, '');
    chunks.forEach((chunk, i) => {
      const firstLine = chunk.split('\n')[0].replace(/^#{1,3}\s*/, '').trim();
      const title = firstLine.length > 8 ? firstLine.slice(0, 200) : `${base} — part ${i + 1}`;
      push('document', title, chunk);
    });
  }

  if (out.length === 0) throw new Error('No usable training entries found in the file.');
  if (out.length > AI_TRAINING_MAX_UPLOAD_ENTRIES)
    throw new Error(
      `File produced ${out.length} entries; max ${AI_TRAINING_MAX_UPLOAD_ENTRIES} per upload. Split it into smaller files.`,
    );
  return out;
}

// --- Retrieval for prompts (pure selection + formatting) --------------------

const STOPWORDS = new Set(
  'the a an and or of to in on for with is are was were be been it its this that these those you your we our they their he she his her at by from as not no do does did can could will would should i me my me please hello hi thanks thank regards dear sir madam'.split(
    ' ',
  ),
);

function tokens(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function scoreEntry(entry: TrainingEntry, queryTokens: Set<string>): number {
  const hayTitle = new Set(tokens(entry.title));
  const hayBody = new Set(tokens(entry.content));
  let score = 0;
  for (const t of queryTokens) {
    if (hayTitle.has(t)) score += 2;
    else if (hayBody.has(t)) score += 1;
  }
  return score;
}

const ALWAYS_FIRST: TrainingKind[] = ['profile', 'tone', 'rule'];

/**
 * Pick the training entries to inject for an inbound message. Pure.
 * Profile / tone / rule entries always come first (they define the
 * business voice); the rest are ranked by keyword overlap with the
 * inbound text. The returned block is capped at `maxChars`.
 */
export function selectTrainingEntries(
  entries: TrainingEntry[],
  inboundText: string,
  maxChars: number = AI_TRAINING_MAX_CHARS,
): TrainingEntry[] {
  const query = new Set(tokens(inboundText));
  const always = entries.filter((e) => ALWAYS_FIRST.includes(e.kind));
  const rest = entries
    .filter((e) => !ALWAYS_FIRST.includes(e.kind))
    .map((e) => ({e, s: scoreEntry(e, query)}))
    .sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title))
    .map((x) => x.e);
  // Ranked rest first when nothing matches: still include the best few
  // so the agent has something business-specific to say; the char cap
  // bounds the cost either way.
  const ordered = [...always, ...rest];
  const picked: TrainingEntry[] = [];
  let used = 0;
  for (const e of ordered) {
    const cost = e.title.length + e.content.length + 16;
    if (picked.length > 0 && used + cost > maxChars) continue;
    picked.push(e);
    used += cost;
    if (used >= maxChars) break;
  }
  return picked;
}

function kindLabel(kind: TrainingKind): string {
  switch (kind) {
    case 'profile':
      return 'Business profile';
    case 'product':
      return 'Product / service';
    case 'faq':
      return 'FAQ';
    case 'tone':
      return 'Tone & style';
    case 'rule':
      return "Do's and don'ts";
    case 'sample_reply':
      return 'Sample reply';
    case 'document':
      return 'Business document';
  }
}

/** Render picked entries as the training block appended to the system prompt. Pure. */
export function formatTrainingBlock(entries: TrainingEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [
    '--- Business training (use only these facts; never invent others) ---',
  ];
  for (const e of entries) {
    if (e.kind === 'faq') {
      lines.push(`FAQ — Q: ${e.title}`);
      lines.push(`A: ${e.content}`);
    } else {
      lines.push(`${kindLabel(e.kind)} — ${e.title}: ${e.content}`);
    }
  }
  lines.push('--- End of business training ---');
  const block = lines.join('\n');
  return block.length > AI_TRAINING_MAX_CHARS
    ? block.slice(0, AI_TRAINING_MAX_CHARS) + '\n[…training truncated…]'
    : block;
}

export interface TrainingContext {
  /** Text appended to the system prompt ('' when no training exists). */
  context: string;
  /** Ids of the entries injected (metadata only — logged, never content). */
  usedEntryIds: string[];
  /** Total training entries in the workspace. */
  totalEntries: number;
  /** Characters of training text injected. */
  chars: number;
}

/** Load a workspace's training and build the injectable context for one inbound message. */
export async function buildTrainingContext(
  workspaceId: string,
  inboundText: string,
): Promise<TrainingContext> {
  const entries = await listTraining(workspaceId);
  if (entries.length === 0)
    return {context: '', usedEntryIds: [], totalEntries: 0, chars: 0};
  const picked = selectTrainingEntries(entries, inboundText);
  const context = formatTrainingBlock(picked);
  return {
    context,
    usedEntryIds: picked.map((e) => e.id),
    totalEntries: entries.length,
    chars: context.length,
  };
}
