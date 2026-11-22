// WorkMail bulk messaging — parsing, validation, templating, campaign runner.
//
// This module owns the "Bulk send" feature end to end EXCEPT the actual
// delivery, which always goes through the shared pipeline
// (lib/service-send.ts `executeSend` -> lib/providers.ts
// `sendWithFallback`). No SMTP/provider code lives here, and no new
// dependencies are used: CSV is parsed by hand and XLSX is parsed as a
// ZIP of XML with node:zlib only.
//
// Serverless execution model (important): Vercel functions have no
// background worker, so a campaign does NOT run to completion inside one
// request. `advanceCampaign` processes at most BULK_TICK_SIZE pending
// recipients per call. The start route calls it once, and the status
// route calls it on every poll while the campaign is `sending` — the
// UI's 2s polling loop is what drives the campaign forward. A stop
// request flips the campaign row to `stopped`; the runner re-reads the
// row before every recipient, so sending halts promptly (at most one
// in-flight send finishes). Already-sent recipients stay `sent`; the
// rest stay `pending`.
//
// Bulk v2 (E3 + E5-5, migration 0008): the engine above is unchanged.
// Added: paste-a-list parsing (parsePastedRecipients), the central
// disposable-domain blocklist (lib/email-validation.ts, G-12), strict
// manual-message rendering (renderTemplateStrict), campaign attachments
// (validateBulkAttachments, 2 MB/file + 1 MB total), and the
// `personalized` flag (SAME vs per-recipient). Campaign creation
// (app/api/bulk/campaigns/route.ts) enforces all of it; the runner only
// renders strictly and passes the stored attachment refs through.
//
// Safety invariants:
//   - Per-campaign recipient cap BULK_MAX_RECIPIENTS (500, free tier).
//   - Suppressed/unsubscribed addresses are excluded at preview time
//     (against the workspace `suppressions` table) AND re-checked
//     immediately before every send (defence in depth; the fallback
//     engine checks a third time before each provider attempt).
//   - Every recipient send uses its own deterministic idempotency key
//     (`bulk:` + sha256(campaignId + ':' + lowercased email)), so a
//     stop/resume or a retry can never deliver a duplicate. If a send
//     was accepted but the recipient row was never marked (crash between
//     the two), the resume replays the same key and `executeSend`
//     returns `duplicate`, which is recorded as `sent`.
//   - A send whose provider outcome is `unknown` (timeout) is recorded
//     as `unknown` and NEVER blindly resent; reconciliation is via the
//     delivery webhook / /api/ops/reconcile, same as single sends.
//     An executeSend outcome of `rejected` whose error says the key is
//     "already processing or has an unknown provider outcome" is also
//     recorded as `unknown`, never `failed` (the send may already have
//     happened; only the provider log can settle it).
//   - Concurrency (RULE 0: no status is ever assumed): a tick first
//     claims the campaign (tick_owner/tick_until lease, released at
//     tick end) and then claims EACH recipient row (claimed_at) before
//     touching it. A claim is won only while the row is still
//     `pending` and unclaimed (or the claim is older than 10 minutes —
//     stale-claim recovery for a tick that crashed mid-recipient).
//     Every recipient write is guarded (status='pending' AND the
//     claim token): 0 changes means another tick already decided the
//     row, so the tick re-reads it, writes nothing and counts nothing.
//     Campaign counts are NEVER incremented in memory — they come
//     only from getBulkCampaignSummary's GROUP BY on bulk_recipients.
//     There is intentionally no in-memory count-increment helper.
//   - If every provider is capped (or unconfigured, or the monthly
//     workspace limit is hit) the campaign pauses cleanly as
//     `paused_caps` with a `pause_reason`; the pending recipient that
//     triggered the pause stays `pending` and a resume picks it up.
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {dbOne, dbQuery, dbRun, jparse, jstr, newId, nowIso} from '@/lib/db';
import {executeSend, resolveFromName} from '@/lib/service-send';
import type {ExecuteSendInput, SendAttachmentRef} from '@/lib/service-send';
import {MAX_ATTACHMENT_COUNT, isSuppressed} from '@/lib/providers';
import {
  brandTemplateHtml,
  buildUnsubscribeMailto,
  getTemplate,
  htmlToText,
  renderTemplateHtml,
  renderTemplateText,
  UnknownTemplateVariableError,
} from '@/lib/templates';

/** Free-tier per-campaign recipient cap. Enforced in code (parse + create) and documented in docs/BULK-MESSAGING.md. */
export const BULK_MAX_RECIPIENTS = 500;
/** Largest accepted upload (CSV or XLSX). */
export const BULK_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Recipients processed per advanceCampaign() call (one start/status tick). */
export const BULK_TICK_SIZE = 10;
/** Campaign starts allowed per workspace per rolling hour (start endpoint). */
export const BULK_MAX_STARTS_PER_HOUR = 5;
/** Accepted upload extensions. `.xls` (binary BIFF) is NOT supported. */
export const BULK_ACCEPTED_EXTENSIONS = ['.csv', '.xlsx'] as const;

export class BulkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkParseError';
  }
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// Bulk v2 — pasted recipient lists, disposable domains, strict manual
// rendering, campaign attachments (E3 + E5-5).
// ---------------------------------------------------------------------------

/** Per-file attachment cap for bulk campaigns (2 MB/file discipline). */
export const BULK_MAX_ATTACHMENT_FILE_BYTES = 2 * 1024 * 1024;
/** Total attachments per message in a bulk campaign (1 MB — the SendPulse
 *  free-tier message-size cap; enforced at creation and shown honestly
 *  in the UI. The shared engine's 10 MB cap still applies underneath.) */
export const BULK_MAX_TOTAL_ATTACHMENT_BYTES = 1 * 1024 * 1024;
/** Variables a bulk campaign can never supply (no per-recipient value
 *  exists for them). Rejected at campaign creation, same as templates. */
export const BULK_UNSUPPLIABLE_VARIABLES = ['otp', 'action_url'] as const;

import {isDisposableDomain, DISPOSABLE_DOMAINS} from '@/lib/email-validation';
// Central disposable/temp-mail blocklist (Phase 3b G-12): the single
// source of truth lives in lib/email-validation.ts (~100 domains). Bulk
// re-exports it so existing import sites (campaigns route, bulk page
// server code) keep working with the same behaviour. The bulk page keeps
// its own client-side mirrored copy for live parse feedback only — the
// server is the authority. Do NOT add a second list here.
export {DISPOSABLE_DOMAINS, isDisposableDomain} from '@/lib/email-validation';

export interface PastedListResult {
  /** Valid, deduped recipients (name empty unless `Name <email>` was pasted). */
  recipients: ParsedRecipient[];
  totalTokens: number;
  invalid: Array<{row: number; email: string; reason: 'invalid_email' | 'disposable_domain'}>;
  duplicatesRemoved: number;
  disposableRejected: Array<{email: string}>;
  suppressed: Array<{email: string; reason: string}>;
}

/**
 * Parse a pasted recipient list: addresses separated by newlines, commas
 * or semicolons; `Name <email@example.com>` is also accepted (the name is
 * kept for {{name}}). Invalid lines are REPORTED (never silently
 * dropped), duplicates are de-duplicated (first wins), disposable
 * domains are rejected, suppressed addresses are excluded — the same
 * order of checks as validateRecipients, so paste and file flows agree.
 * `row` is the 1-based position of the token in the pasted list.
 */
export function parsePastedRecipients(
  text: string,
  suppressed: Map<string, string>,
): PastedListResult {
  const tokens = text
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const recipients: ParsedRecipient[] = [];
  const invalid: PastedListResult['invalid'] = [];
  const disposableRejected: Array<{email: string}> = [];
  const suppressedOut: Array<{email: string; reason: string}> = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  tokens.forEach((token, idx) => {
    const row = idx + 1;
    // `Name <email>` form: take the address in brackets, keep the name.
    const angled = /^(.*)<\s*([^<>\s]+)\s*>$/.exec(token);
    const name = angled ? angled[1].trim().replace(/^["']|["']$/g, '') : '';
    const email = (angled ? angled[2] : token).trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      invalid.push({row, email: token, reason: 'invalid_email'});
      return;
    }
    if (isDisposableDomain(email)) {
      invalid.push({row, email, reason: 'disposable_domain'});
      disposableRejected.push({email});
      return;
    }
    if (seen.has(email)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(email);
    const reason = suppressed.get(email);
    if (reason !== undefined) {
      suppressedOut.push({email, reason});
      return;
    }
    recipients.push({email, name, fields: {}, row});
  });
  return {
    recipients,
    totalTokens: tokens.length,
    invalid,
    duplicatesRemoved,
    disposableRejected,
    suppressed: suppressedOut,
  };
}

/** Thrown by renderTemplateStrict when a recipient cannot supply a variable. */
export class BulkRenderError extends Error {
  variables: string[];
  constructor(variables: string[]) {
    super(
      `Message uses variable(s) this recipient cannot supply: ${variables.map((v) => `{{${v}}}`).join(', ')}. Values are never guessed or dropped silently.`,
    );
    this.name = 'BulkRenderError';
    this.variables = variables;
  }
}

/**
 * Strict per-recipient render for MANUAL bulk messages (E3): every
 * {{variable}} must have a value in the recipient context (email, name,
 * CSV columns) or the automatic context (sender_name,
 * unsubscribe_url). An unknown variable throws BulkRenderError so the
 * runner fails THAT recipient honestly — never an empty render, never
 * a skipped send. (The non-strict renderTemplate above stays for
 * previews, where unknown variables render empty with a warning.)
 */
export function renderTemplateStrict(
  template: string,
  recipient: ParsedRecipient,
  extra: Record<string, string>,
): string {
  const ctx: Record<string, string> = {
    email: recipient.email,
    name: recipient.name,
    ...recipient.fields,
    ...extra,
  };
  const unknown = findUnknownPlaceholders(template, Object.keys(ctx));
  if (unknown.length > 0) throw new BulkRenderError(unknown);
  return renderTemplate(template, recipient);
}

/**
 * Validate a campaign's attachment set (E5-5) BEFORE creation: one set
 * per campaign, uploaded via POST /api/attachments (KV-stored, no
 * message_id — the object_key form). Ownership is proven by the KV key
 * prefix `att/<workspaceId>/<mailboxId>/` (same proof the send engine
 * requires). Per-file ≤ 2 MB, total ≤ 1 MB (SendPulse free-tier cap),
 * at most MAX_ATTACHMENT_COUNT files. Returns the total bytes on success
 * so the caller can show the honest "X KB of 1 MB" state.
 */
export function validateBulkAttachments(
  refs: SendAttachmentRef[],
  workspaceId: string,
  mailboxId: string,
): {ok: true; totalBytes: number} | {ok: false; error: string} {
  if (!Array.isArray(refs)) return {ok: false, error: 'Attachments must be a list.'};
  if (refs.length > MAX_ATTACHMENT_COUNT)
    return {ok: false, error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT} per campaign).`};
  const keyPrefix = `att/${workspaceId}/${mailboxId}/`;
  let total = 0;
  for (const r of refs) {
    if (r.attachment_id)
      return {
        ok: false,
        error: 'Bulk campaigns use freshly uploaded attachments (object_key form). Re-upload the file on the bulk page.',
      };
    const key = String(r.object_key || '');
    if (!key.startsWith(keyPrefix))
      return {ok: false, error: 'Attachment not found for this mailbox.'};
    if (!r.file_name || typeof r.size_bytes !== 'number')
      return {ok: false, error: 'Each attachment needs a file_name and size_bytes.'};
    if (r.size_bytes < 1 || r.size_bytes > BULK_MAX_ATTACHMENT_FILE_BYTES)
      return {
        ok: false,
        error: `Attachment "${r.file_name}" exceeds the 2 MB per-file limit for bulk sends.`,
      };
    total += r.size_bytes;
  }
  if (total > BULK_MAX_TOTAL_ATTACHMENT_BYTES)
    return {
      ok: false,
      error: `Attachments total ${Math.round(total / 1024)} KB — over the 1 MB per-message limit for bulk sends (SendPulse free tier). Remove a file or use a smaller one.`,
    };
  return {ok: true, totalBytes: total};
}

// ---------------------------------------------------------------------------
// CSV parsing (dependency-free, RFC 4180-ish: quoted fields, "" escapes,
// CRLF / LF / CR line endings, UTF-8 BOM stripped)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      // A quote only opens a quoted field at the start of a field.
      if (field === '') inQuotes = true;
      else field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing content without a newline still forms a row.
  if (field !== '' || row.length > 0) pushRow();
  // Drop fully-empty trailing rows (a trailing newline produces none, but
  // a file ending in blank lines does).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------
// XLSX parsing (dependency-free: ZIP central directory + node:zlib inflate,
// then regex extraction of sharedStrings.xml + the first worksheet XML)
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  // Locate the End Of Central Directory record (search backwards; the
  // comment makes its position variable).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BulkParseError('Not a valid .xlsx file (no ZIP end-of-central-directory record).');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, {name, method, compressedSize, localHeaderOffset});
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.size === 0) throw new BulkParseError('Not a valid .xlsx file (empty ZIP central directory).');
  return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50)
    throw new BulkParseError(`Corrupt .xlsx file (bad local header for ${entry.name}).`);
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new BulkParseError(`Corrupt .xlsx file (truncated entry ${entry.name}).`);
  const data = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new BulkParseError(`Unsupported .xlsx compression method ${entry.method} in ${entry.name}.`);
}

function columnLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsxSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const grid = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowXml = rowMatch[1];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml)) !== null) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || '';
      const ref = / r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const col = columnLettersToIndex(ref[1]);
      const rowIdx = parseInt(ref[2], 10) - 1;
      const type = / t="([^"]+)"/.exec(attrs)?.[1] || '';
      let value = '';
      if (type === 's') {
        const v = /<v>(-?\d+)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) value = sharedStrings[parseInt(v, 10)] ?? '';
      } else if (type === 'inlineStr') {
        const tRe = /<t[^>]*>([^<]*)<\/t>/g;
        let tMatch: RegExpExecArray | null;
        const parts: string[] = [];
        while ((tMatch = tRe.exec(inner)) !== null) parts.push(decodeXmlEntities(tMatch[1]));
        value = parts.join('');
      } else {
        // Number, boolean, formula string (`str`), or date serial:
        // rendered as the stored text. Date serials stay numeric —
        // callers should use text columns for dates.
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) value = decodeXmlEntities(v);
      }
      if (!grid.has(rowIdx)) grid.set(rowIdx, new Map());
      grid.get(rowIdx)!.set(col, value);
      if (rowIdx > maxRow) maxRow = rowIdx;
      if (col > maxCol) maxCol = col;
    }
  }
  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const rowMap = grid.get(r);
    const row: string[] = [];
    for (let c = 0; c <= maxCol; c++) row.push(rowMap?.get(c) ?? '');
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

export function parseXlsx(buf: Buffer): string[][] {
  const entries = readZipEntries(buf);
  const sharedStringsXml = entries.get('xl/sharedStrings.xml');
  const sharedStrings: string[] = [];
  if (sharedStringsXml) {
    const xml = readZipEntry(buf, sharedStringsXml).toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let si: RegExpExecArray | null;
    while ((si = siRe.exec(xml)) !== null) {
      const tRe = /<t[^>]*>([^<]*)<\/t>/g;
      let t: RegExpExecArray | null;
      const parts: string[] = [];
      while ((t = tRe.exec(si[1])) !== null) parts.push(decodeXmlEntities(t[1]));
      sharedStrings.push(parts.join(''));
    }
  }
  // First worksheet (lowest sheet number). workbook.xml/_rels resolution
  // is unnecessary: sheet1.xml is the first sheet in every writer we
  // support (Excel, Google Sheets export, LibreOffice).
  const sheetNames = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(/sheet(\d+)\.xml$/.exec(a)![1], 10);
      const nb = parseInt(/sheet(\d+)\.xml$/.exec(b)![1], 10);
      return na - nb;
    });
  if (sheetNames.length === 0) throw new BulkParseError('No worksheet found in the .xlsx file.');
  const sheetXml = readZipEntry(buf, entries.get(sheetNames[0])!).toString('utf8');
  return parseXlsxSheetXml(sheetXml, sharedStrings);
}

/** Parse an uploaded file into a string grid (first row = headers). */
export function parseSheet(buf: Buffer, filename: string): string[][] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(buf.toString('utf8'));
  if (lower.endsWith('.xlsx')) return parseXlsx(buf);
  throw new BulkParseError('Unsupported file type. Upload a .csv or .xlsx file.');
}

// ---------------------------------------------------------------------------
// Sheet rows -> recipients
// ---------------------------------------------------------------------------

export interface ParsedRecipient {
  /** Lowercased, trimmed email (the canonical form used for dedupe, suppression and sending). */
  email: string;
  name: string;
  /** Custom columns only (email/name excluded); keys are lowercased header names. */
  fields: Record<string, string>;
  /** 1-based sheet row number (header is row 1). */
  row: number;
}

export interface BulkValidation {
  /** Lowercased header names, in sheet order. */
  columns: string[];
  /** Data rows seen (excluding the header and fully-empty rows). */
  totalRows: number;
  valid: ParsedRecipient[];
  invalid: Array<{row: number; email: string; reason: 'missing_email' | 'invalid_email' | 'disposable_domain'}>;
  duplicatesRemoved: number;
  suppressed: Array<{email: string; reason: string}>;
}

/**
 * Convert a parsed grid into recipients. Throws BulkParseError when the
 * header row is missing or has no `email` column. Fully-empty rows are
 * skipped silently; rows with a missing/bad email are reported, not
 * thrown, so the preview can show them.
 */
export function sheetRowsToRecipients(grid: string[][]): {
  columns: string[];
  recipients: ParsedRecipient[];
  totalRows: number;
} {
  if (grid.length === 0) throw new BulkParseError('The file is empty.');
  const rawHeaders = grid[0].map((h) => h.trim());
  const columns = rawHeaders.map((h) => h.toLowerCase());
  if (columns.every((c) => c === '')) throw new BulkParseError('The first row must contain column headers (email, name, …).');
  const emailCol = columns.indexOf('email');
  if (emailCol < 0) throw new BulkParseError('No "email" column found in the first row. Rename the email column to "email".');
  const nameCol = columns.indexOf('name');
  const recipients: ParsedRecipient[] = [];
  let totalRows = 0;
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === '')) continue;
    totalRows += 1;
    const email = (row[emailCol] || '').trim().toLowerCase();
    const name = nameCol >= 0 ? (row[nameCol] || '').trim() : '';
    const fields: Record<string, string> = {};
    columns.forEach((col, idx) => {
      if (!col || idx === emailCol || idx === nameCol) return;
      fields[col] = (row[idx] || '').trim();
    });
    recipients.push({email, name, fields, row: i + 1});
  }
  if (totalRows === 0) throw new BulkParseError('The file has headers but no data rows.');
  return {columns, recipients, totalRows};
}

/**
 * Validate + dedupe recipients against the workspace suppression map
 * (email -> reason, from `suppressions`). Order of checks per row:
 * missing/bad email -> disposable domain (G-12, rejected with a clear
 * reason — never silently dropped) -> duplicate (case-insensitive, keep
 * first) -> suppressed. Suppressed addresses are EXCLUDED from `valid` —
 * they never receive mail.
 */
export function validateRecipients(
  recipients: ParsedRecipient[],
  suppressed: Map<string, string>,
): BulkValidation & {columns: string[]} {
  const columns: string[] = [];
  const seen = new Set<string>();
  const valid: ParsedRecipient[] = [];
  const invalid: BulkValidation['invalid'] = [];
  const suppressedOut: Array<{email: string; reason: string}> = [];
  let duplicatesRemoved = 0;
  for (const r of recipients) {
    for (const k of Object.keys(r.fields)) if (!columns.includes(k)) columns.push(k);
    if (!r.email) {
      invalid.push({row: r.row, email: '', reason: 'missing_email'});
      continue;
    }
    if (!isValidEmail(r.email)) {
      invalid.push({row: r.row, email: r.email, reason: 'invalid_email'});
      continue;
    }
    if (isDisposableDomain(r.email)) {
      invalid.push({row: r.row, email: r.email, reason: 'disposable_domain'});
      continue;
    }
    if (seen.has(r.email)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(r.email);
    const reason = suppressed.get(r.email);
    if (reason !== undefined) {
      suppressedOut.push({email: r.email, reason});
      continue;
    }
    valid.push(r);
  }
  return {
    columns,
    totalRows: recipients.length,
    valid,
    invalid,
    duplicatesRemoved,
    suppressed: suppressedOut,
  };
}

// ---------------------------------------------------------------------------
// Placeholders: {{name}} / {{field}} — any column name may be used.
// Missing fields render as empty; unknown placeholders are flagged in
// preview (never a crash, never a send blocker).
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function extractPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) found.add(m[1].toLowerCase());
  return [...found];
}

export function findUnknownPlaceholders(template: string, knownColumns: string[]): string[] {
  const known = new Set(knownColumns.map((c) => c.toLowerCase()));
  return extractPlaceholders(template).filter((p) => !known.has(p));
}

/** Render one template against one recipient. Missing fields render empty. */
export function renderTemplate(template: string, recipient: ParsedRecipient): string {
  const ctx: Record<string, string> = {email: recipient.email, name: recipient.name, ...recipient.fields};
  return template.replace(PLACEHOLDER_RE, (_, key: string) => ctx[key.toLowerCase()] ?? '');
}

// ---------------------------------------------------------------------------
// Idempotency: one deterministic key per (campaign, recipient).
// ---------------------------------------------------------------------------

export function bulkIdempotencyKey(campaignId: string, email: string): string {
  return (
    'bulk:' + createHash('sha256').update(campaignId + ':' + email.toLowerCase()).digest('hex')
  );
}

// ---------------------------------------------------------------------------
// Campaign state + runner
// ---------------------------------------------------------------------------

export interface BulkCampaignSummary {
  id: string;
  workspace_id: string;
  mailbox_id: string;
  name: string;
  subject: string;
  status: string;
  /** 'auto' (fallback chain) or one provider name; stored on the campaign row, carried to executeSend. */
  provider: string;
  /** Template rendered per recipient at send time, or null for a plain campaign. */
  template_id: string | null;
  /** Bulk v2: true = per-recipient rendering ({{name}}, {{email}}, CSV columns); false = SAME, one identical body for everyone. */
  personalized: boolean;
  /** Bulk v2 (E5-5): one attachment set per campaign (SendAttachmentRef list, object_key form), or [] for none. */
  attachments: SendAttachmentRef[];
  total_recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  pending: number;
  pause_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export async function getBulkCampaignSummary(campaignId: string): Promise<BulkCampaignSummary | null> {
  const c = await dbOne('SELECT * FROM bulk_campaigns WHERE id = ?', [campaignId]);
  if (!c) return null;
  const counts = await dbQuery(
    "SELECT status, COUNT(*) AS n FROM bulk_recipients WHERE campaign_id = ? GROUP BY status",
    [campaignId],
  );
  const byStatus: Record<string, number> = {};
  for (const r of counts) byStatus[String(r.status)] = Number(r.n);
  return {
    id: String(c.id),
    workspace_id: String(c.workspace_id),
    mailbox_id: String(c.mailbox_id),
    name: String(c.name || ''),
    subject: String(c.subject || ''),
    status: String(c.status),
    provider: typeof c.provider === 'string' && c.provider ? String(c.provider) : 'auto',
    template_id: c.template_id ? String(c.template_id) : null,
    // Columns added by migration 0008; a row predating it reads as
    // personalized with no attachments (the pre-v2 behaviour).
    personalized: c.personalized === undefined || c.personalized === null ? true : Number(c.personalized) === 1,
    attachments: jparse<SendAttachmentRef[]>(typeof c.attachments === 'string' ? c.attachments : '[]', []),
    total_recipients: Number(c.total_recipients),
    sent: byStatus['sent'] || 0,
    failed: byStatus['failed'] || 0,
    skipped: byStatus['skipped'] || 0,
    unknown: byStatus['unknown'] || 0,
    pending: byStatus['pending'] || 0,
    pause_reason: c.pause_reason ? String(c.pause_reason) : null,
    started_at: c.started_at ? String(c.started_at) : null,
    finished_at: c.finished_at ? String(c.finished_at) : null,
    created_at: String(c.created_at),
  };
}

// ---------------------------------------------------------------------------
// Guarded recipient writes + claims (RULE 0). See the module header.
// ---------------------------------------------------------------------------

/** A claim older than this with status still 'pending' may be re-claimed by a later tick. */
export const BULK_STALE_CLAIM_MS = 10 * 60 * 1000;
/** Campaign-level tick lease length. A tick that runs longer than this may be overlapped by the next tick — the per-recipient claim still protects every row. */
export const BULK_TICK_LEASE_MS = 180 * 1000;

/**
 * Guarded recipient write: applies ONLY while the row is still
 * `pending` (and, when a claim token is given, still owned by this
 * tick). Returns true when the write applied. On 0 changes another
 * tick already decided the row: the row is re-read for the log, and
 * NOTHING is written or counted by this tick.
 */
async function setRecipient(
  recipientId: string,
  patch: {
    status: string;
    provider?: string | null;
    provider_message_id?: string | null;
    message_id?: string | null;
    error?: string | null;
    sent_at?: string | null;
  },
  claimToken?: string | null,
): Promise<boolean> {
  const params: unknown[] = [
    patch.status,
    patch.provider ?? null,
    patch.provider_message_id ?? null,
    patch.message_id ?? null,
    patch.error ?? null,
    patch.sent_at ?? null,
    nowIso(),
  ];
  let sql =
    `UPDATE bulk_recipients SET status = ?, provider = ?, provider_message_id = ?, message_id = ?, error = ?, sent_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`;
  params.push(recipientId);
  if (claimToken) {
    sql += ' AND claimed_at = ?';
    params.push(claimToken);
  }
  const res = await dbRun(sql, params);
  if (res.changes === 1) return true;
  const current = await dbOne('SELECT status FROM bulk_recipients WHERE id = ?', [recipientId]).catch(() => null);
  console.warn('[bulk] setRecipient skipped: row already decided by another tick', {
    recipientId,
    wanted: patch.status,
    currentStatus: current?.status ?? null,
  });
  return false;
}

/**
 * Claim one recipient row for this tick. Wins only while the row is
 * still `pending` and unclaimed, or its claim is older than
 * BULK_STALE_CLAIM_MS (a previous tick crashed mid-recipient).
 * Returns true only when this tick now owns the row.
 */
async function claimRecipient(recipientId: string, claimToken: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - BULK_STALE_CLAIM_MS).toISOString();
  const res = await dbRun(
    `UPDATE bulk_recipients SET claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?)`,
    [claimToken, nowIso(), recipientId, staleBefore],
  );
  return res.changes === 1;
}

/** Release this tick's claim on a row it did NOT decide (pause path), so a resume can claim it immediately instead of waiting out the 10-minute staleness window. */
async function releaseClaim(recipientId: string, claimToken: string): Promise<void> {
  await dbRun(
    `UPDATE bulk_recipients SET claimed_at = NULL, updated_at = ? WHERE id = ? AND claimed_at = ?`,
    [nowIso(), recipientId, claimToken],
  ).catch(() => {});
}

/**
 * Claim the campaign-level tick lease. Returns the lease owner token
 * when this tick won it, or null when another tick already holds a
 * live lease (or the campaign is no longer `sending`). A losing tick
 * processes nothing and just returns the last-known summary.
 */
async function claimTick(campaignId: string): Promise<string | null> {
  const owner = newId();
  const until = new Date(Date.now() + BULK_TICK_LEASE_MS).toISOString();
  const res = await dbRun(
    `UPDATE bulk_campaigns SET tick_owner = ?, tick_until = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND (tick_until IS NULL OR tick_until < ?)`,
    [owner, until, nowIso(), campaignId, nowIso()],
  );
  return res.changes === 1 ? owner : null;
}

/** Release the tick lease, but only if this tick still owns it. Never throws. */
async function releaseTick(campaignId: string, owner: string): Promise<void> {
  await dbRun(
    `UPDATE bulk_campaigns SET tick_owner = NULL, tick_until = NULL, updated_at = ? WHERE id = ? AND tick_owner = ?`,
    [nowIso(), campaignId, owner],
  ).catch(() => {});
}

async function pauseCampaign(campaignId: string, reason: string): Promise<void> {
  await dbRun(
    `UPDATE bulk_campaigns SET status = 'paused_caps', pause_reason = ?, updated_at = ? WHERE id = ?`,
    [reason, nowIso(), campaignId],
  );
}

/**
 * Sync the STORED campaign counters from bulk_recipients (G5b). The UI
 * derives counts from recipients, but the stored sent_count/failed_count
 * must agree too — they were stale live (0/2 stored vs 2 sent). The
 * counts come only from a GROUP-BY-equivalent COUNT here, never from
 * in-memory increments (see the module header). Best-effort: a failure
 * is logged, never thrown — the tick already decided the recipients.
 */
export async function syncBulkCampaignCounters(campaignId: string): Promise<void> {
  try {
    await dbRun(
      `UPDATE bulk_campaigns SET
         sent_count = (SELECT COUNT(*) FROM bulk_recipients WHERE campaign_id = ? AND status = 'sent'),
         failed_count = (SELECT COUNT(*) FROM bulk_recipients WHERE campaign_id = ? AND status = 'failed'),
         updated_at = ?
       WHERE id = ?`,
      [campaignId, campaignId, nowIso(), campaignId],
    );
  } catch (e) {
    console.warn('[bulk] syncBulkCampaignCounters failed', {
      campaignId,
      error: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

async function finishCampaignIfDone(campaignId: string): Promise<void> {
  const pending = await dbOne(
    "SELECT COUNT(*) AS n FROM bulk_recipients WHERE campaign_id = ? AND status = 'pending'",
    [campaignId],
  );
  if (Number(pending?.n || 0) === 0) {
    await dbRun(
      `UPDATE bulk_campaigns SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
      [nowIso(), nowIso(), campaignId],
    );
  }
  // Stored counters are synced on every tick completion, not only when
  // the campaign finishes (paused/stopped campaigns report honestly too).
  await syncBulkCampaignCounters(campaignId);
}

/**
 * Process up to `maxRecipients` pending recipients of a `sending`
 * campaign. No-op (returns the current summary) for any other status,
 * or when another tick already holds the campaign lease. The campaign
 * row is re-read before every recipient so a stop request halts
 * sending promptly. See the module header for the tick model.
 *
 * Per-recipient failure isolation: EACH recipient iteration is wrapped
 * in try/catch. A throw (executeSend, D1, anything) records that
 * recipient as `unknown` through the guarded write and the tick
 * continues with the next recipient — one bad row never aborts the
 * tick or skips finishCampaignIfDone.
 */
export async function advanceCampaign(
  campaignId: string,
  maxRecipients: number = BULK_TICK_SIZE,
): Promise<BulkCampaignSummary> {
  const campaign = await dbOne('SELECT * FROM bulk_campaigns WHERE id = ?', [campaignId]);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status !== 'sending') {
    const summary = await getBulkCampaignSummary(campaignId);
    if (!summary) throw new Error('Campaign not found.');
    return summary;
  }
  // Campaign-level tick lease (belt-and-braces over the per-recipient
  // claim). A losing tick processes nothing.
  const tickOwner = await claimTick(campaignId);
  if (!tickOwner) {
    const summary = await getBulkCampaignSummary(campaignId);
    if (!summary) throw new Error('Campaign not found.');
    return summary;
  }
  try {
    const summary = await advanceCampaignClaimed(campaign, maxRecipients);
    // Tick completion: stored counters agree with the recipient rows
    // (finishCampaignIfDone already synced, but the claimed path has
    // early returns that skip it — sync here so every tick leaves
    // honest stored counts behind).
    await syncBulkCampaignCounters(campaignId);
    return await getBulkCampaignSummary(campaignId).then((s) => s || summary);
  } finally {
    await releaseTick(campaignId, tickOwner);
  }
}

async function advanceCampaignClaimed(
  campaign: Record<string, unknown>,
  maxRecipients: number,
): Promise<BulkCampaignSummary> {
  const campaignId = String(campaign.id);
  const sender = await dbOne(
    'SELECT id, address, display_name, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ?',
    [campaign.mailbox_id, campaign.workspace_id],
  );
  if (!sender) {
    await dbRun(
      `UPDATE bulk_campaigns SET status = 'failed', pause_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      ['Sender mailbox no longer exists.', nowIso(), nowIso(), campaignId],
    );
    const summary = await getBulkCampaignSummary(campaignId);
    if (!summary) throw new Error('Campaign not found.');
    return summary;
  }
  const recipients = await dbQuery(
    "SELECT * FROM bulk_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?",
    [campaignId, maxRecipients],
  );
  if (recipients.length === 0) {
    await finishCampaignIfDone(campaignId);
    const summary = await getBulkCampaignSummary(campaignId);
    if (!summary) throw new Error('Campaign not found.');
    return summary;
  }
  // Campaign provider choice: 'auto' = fallback chain, or one provider
  // name = ONLY that provider (no silent fallback — enforced in the
  // send engine, which validates a manual pick before calling any
  // provider). Carried verbatim to executeSend. Any unexpected stored
  // value falls back to 'auto' rather than inventing a provider.
  const campaignProvider: 'auto' | 'sendpulse' | 'brevo' | 'mailjet' | 'resend' =
    campaign.provider === 'sendpulse' ||
    campaign.provider === 'brevo' ||
    campaign.provider === 'mailjet' ||
    campaign.provider === 'resend'
      ? campaign.provider
      : 'auto';
  // Template (Phase 1): when the campaign carries a template_id, the
  // stored template is rendered per recipient at send time (server-side
  // only). A template deleted after campaign creation fails the
  // campaign honestly instead of sending plain content.
  const campaignTemplate = campaign.template_id
    ? await getTemplate(String(campaign.workspace_id), String(campaign.template_id))
    : null;
  if (campaign.template_id && !campaignTemplate) {
    await dbRun(
      `UPDATE bulk_campaigns SET status = 'failed', pause_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      ['The campaign template was deleted after the campaign was created.', nowIso(), nowIso(), campaignId],
    );
    const summary = await getBulkCampaignSummary(campaignId);
    if (!summary) throw new Error('Campaign not found.');
    return summary;
  }
  // Campaign attachments (Bulk v2, E5-5): one set per campaign, stored
  // as JSON on the row, resolved per recipient by the shared send
  // engine. Caps (2 MB/file, 1 MB total) were enforced at creation;
  // a missing KV object fails each recipient honestly via executeSend.
  const campaignAttachments = jparse<SendAttachmentRef[]>(
    typeof campaign.attachments === 'string' ? campaign.attachments : '[]',
    [],
  );
  const bulkFromName = await resolveFromName(String(campaign.workspace_id), {
    id: String(sender.id),
    address: String(sender.address),
    display_name: sender.display_name ? String(sender.display_name) : null,
    domain_id: String(sender.domain_id),
  });
  const bulkUnsubscribeUrl = buildUnsubscribeMailto(String(sender.address));
  for (const rec of recipients) {
    // Stop check before every recipient — the stop route flips this row.
    const live = await dbOne('SELECT status FROM bulk_campaigns WHERE id = ?', [campaignId]);
    if (!live || live.status !== 'sending') break;
    const recipientId = String(rec.id);
    const claimToken = newId();
    try {
      // Per-recipient claim: a lost claim means another tick owns or
      // already decided this row — skip it, decide nothing.
      if (!(await claimRecipient(recipientId, claimToken))) continue;
      const email = String(rec.email);
      const recipient: ParsedRecipient = {
        email,
        name: String(rec.name || ''),
        fields: jparse<Record<string, string>>(String(rec.fields || '{}'), {}),
        row: 0,
      };
      // Suppression re-check right before the send (defence in depth).
      const suppression = await isSuppressed(String(campaign.workspace_id), email);
      if (suppression.suppressed) {
        await setRecipient(
          recipientId,
          {status: 'skipped', error: `Suppressed (${suppression.reason || 'suppressed'}).`},
          claimToken,
        );
        continue;
      }
      let subject: string;
      let text: string;
      let html: string;
      if (campaignTemplate) {
        // Template render per recipient (strict): the recipient's own
        // columns + email/name + sender_name + unsubscribe_url are the
        // context. A variable the recipient cannot supply (e.g. {{otp}})
        // was already rejected at campaign creation; if one still shows
        // up, the recipient fails honestly with the reason — never an
        // empty render, never a skipped send.
        const ctx: Record<string, string> = {
          email,
          name: String(rec.name || ''),
          ...recipient.fields,
          sender_name: bulkFromName,
          unsubscribe_url: bulkUnsubscribeUrl,
        };
        try {
          subject = renderTemplateText(campaignTemplate.subject, ctx, true);
          html = renderTemplateHtml(campaignTemplate.html_body, ctx, true);
          text = campaignTemplate.text_body
            ? renderTemplateText(campaignTemplate.text_body, ctx, true)
            : htmlToText(html);
        } catch (e) {
          const reason =
            e instanceof UnknownTemplateVariableError
              ? e.message
              : 'Template render failed.';
          await setRecipient(recipientId, {status: 'failed', error: reason}, claimToken);
          continue;
        }
        // Branded header (2026-11-22): same as executeSend — custom
        // templates carry no logo header; wrap when the rendered HTML
        // lacks one. Defaults already contain it and are skipped.
        html = brandTemplateHtml(html, bulkFromName);
      } else {
        // Manual message (Bulk v2): strict per-recipient render. In
        // PERSONALIZED mode {{name}}/{{email}}/CSV columns resolve per
        // recipient; in SAME mode creation already rejected every
        // per-recipient variable, so the same render produces one
        // identical body for everyone. A variable no recipient can
        // supply fails THIS recipient honestly (BulkRenderError) —
        // never an empty render, never a skipped send.
        try {
          const manualCtx = {sender_name: bulkFromName, unsubscribe_url: bulkUnsubscribeUrl};
          subject = renderTemplateStrict(String(campaign.subject || ''), recipient, manualCtx);
          text = renderTemplateStrict(String(campaign.text_body || ''), recipient, manualCtx);
          html = renderTemplateStrict(String(campaign.html_body || ''), recipient, manualCtx);
        } catch (e) {
          const reason =
            e instanceof BulkRenderError ? e.message : 'Message render failed.';
          await setRecipient(recipientId, {status: 'failed', error: reason}, claimToken);
          continue;
        }
      }
      // executeSend's `provider` input ('auto' = fallback chain, or a
      // single provider name). The send engine validates a manual pick
      // (enabled + sender-verified) before calling any provider.
      const sendInput: ExecuteSendInput = {
        workspaceId: String(campaign.workspace_id),
        sender: {
          id: String(sender.id),
          address: String(sender.address),
          display_name: sender.display_name ? String(sender.display_name) : null,
          domain_id: String(sender.domain_id),
        },
        to: email,
        subject,
        text: text || undefined,
        html: html || undefined,
        idempotencyKey: String(rec.idempotency_key),
        provider: campaignProvider,
        // Every bulk send carries the List-Unsubscribe header + footer
        // link (added in executeSend from this address).
        unsubscribeUrl: bulkUnsubscribeUrl,
        // Bulk v2 (E5-5): the campaign's one attachment set, same files
        // for every recipient.
        attachments: campaignAttachments.length > 0 ? campaignAttachments : undefined,
      };
      const exec = await executeSend(sendInput, {
        kind: 'user',
        userId: campaign.created_by ? String(campaign.created_by) : null,
      });
      const attempts = Array.isArray((exec.body as {attempts?: unknown[]}).attempts)
        ? ((exec.body as {attempts: Array<{result?: string}>}).attempts)
        : [];
      if (exec.outcome === 'accepted' || exec.outcome === 'duplicate') {
        // `duplicate` = the same key+content was already accepted (e.g. a
        // crash between accept and marking the row). It is a sent mail,
        // not a second delivery.
        await setRecipient(
          recipientId,
          {
            status: 'sent',
            provider: exec.provider,
            provider_message_id: exec.providerMessageId,
            message_id: exec.messageId,
            sent_at: nowIso(),
          },
          claimToken,
        );
        continue;
      }
      if (exec.outcome === 'unknown') {
        await setRecipient(
          recipientId,
          {
            status: 'unknown',
            provider: exec.provider,
            error: 'Provider outcome unknown after timeout. Do not resend until provider logs are checked.',
          },
          claimToken,
        );
        continue;
      }
      if (exec.outcome === 'suppressed') {
        await setRecipient(
          recipientId,
          {status: 'skipped', error: 'Recipient is on the workspace suppression list.'},
          claimToken,
        );
        continue;
      }
      if (exec.outcome === 'failed') {
        const allCapped = attempts.length > 0 && attempts.every((a) => a.result === 'cap_exhausted');
        const allUnconfigured = attempts.length > 0 && attempts.every((a) => a.result === 'unconfigured');
        if (allCapped) {
          // Clean pause: the triggering recipient stays `pending` and a
          // resume picks it up once a cap window frees. Release its
          // claim so the resume can claim it immediately.
          await releaseClaim(recipientId, claimToken);
          await pauseCampaign(campaignId, 'provider_caps: all providers are at their free-tier caps. Resume after a cap window resets.');
          break;
        }
        if (allUnconfigured) {
          await releaseClaim(recipientId, claimToken);
          await pauseCampaign(campaignId, 'no_providers_configured: no provider in the fallback chain has credentials. Connect a provider, then resume.');
          break;
        }
        await setRecipient(
          recipientId,
          {
            status: 'failed',
            error: 'All configured providers rejected the send.',
          },
          claimToken,
        );
        continue;
      }
      // 'rejected': monthly limit pauses the campaign; a key stuck at
      // 'processing'/'unknown' is `unknown`, never `failed`; anything
      // else is a per-recipient failure (bad domain, …).
      const errText = typeof exec.body?.error === 'string' ? exec.body.error : 'Send rejected.';
      if (errText.includes('Monthly sending limit')) {
        await releaseClaim(recipientId, claimToken);
        await pauseCampaign(campaignId, 'monthly_limit: the workspace monthly sending limit was reached. Resume next month (or after a limit increase).');
        break;
      }
      if (errText.includes('already processing or has an unknown provider outcome')) {
        await setRecipient(
          recipientId,
          {
            status: 'unknown',
            provider: exec.provider,
            error: 'Send already processing or has an unknown provider outcome. Do not resend until provider logs are checked.',
          },
          claimToken,
        );
        continue;
      }
      await setRecipient(recipientId, {status: 'failed', error: errText}, claimToken);
    } catch (err) {
      // One recipient's failure never aborts the tick. Record it as
      // `unknown` (no provider outcome was established) through the
      // guarded write, then continue with the next recipient.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[bulk] recipient tick error — recorded as unknown', {
        campaignId,
        recipientId,
        error: message,
      });
      try {
        await setRecipient(
          recipientId,
          {
            status: 'unknown',
            error: `Tick failed before a provider outcome was recorded: ${message}. Do not resend until provider logs are checked.`,
          },
          claimToken,
        );
      } catch (writeErr) {
        console.error('[bulk] could not record unknown status for recipient', {
          campaignId,
          recipientId,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
      continue;
    }
  }
  await finishCampaignIfDone(campaignId);
  const summary = await getBulkCampaignSummary(campaignId);
  if (!summary) throw new Error('Campaign not found.');
  return summary;
}

// ---------------------------------------------------------------------------
// Rate limiting (start endpoint) — per-instance, in-memory, same caveat as
// middleware.ts: approximate under multi-instance load, not a WAF.
// ---------------------------------------------------------------------------

const startBuckets = new Map<string, number[]>();

export function checkBulkStartRateLimit(workspaceId: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const list = (startBuckets.get(workspaceId) || []).filter((t) => t > hourAgo);
  if (list.length >= BULK_MAX_STARTS_PER_HOUR) {
    return {allowed: false, retryAfterSeconds: Math.ceil((list[0] + 60 * 60 * 1000 - now) / 1000)};
  }
  list.push(now);
  startBuckets.set(workspaceId, list);
  return {allowed: true, retryAfterSeconds: 0};
}

// ---------------------------------------------------------------------------
// Monthly quota helper (for the create/preview warning)
// ---------------------------------------------------------------------------

export async function monthlySendRemaining(workspaceId: string): Promise<{
  limit: number;
  used: number;
  remaining: number;
}> {
  const settings = await dbOne('SELECT monthly_send_limit FROM workspace_settings WHERE workspace_id = ?', [workspaceId]);
  const period = new Date().toISOString().slice(0, 7) + '-01';
  const usage = await dbOne('SELECT sent_count FROM usage_counters WHERE workspace_id = ? AND period_start = ?', [
    workspaceId,
    period,
  ]);
  const limit = Number(settings?.monthly_send_limit ?? 300);
  const used = Number(usage?.sent_count ?? 0);
  return {limit, used, remaining: Math.max(0, limit - used)};
}

/** Load the workspace suppression map (lowercased email -> reason) in one query. */
export async function loadSuppressionMap(workspaceId: string): Promise<Map<string, string>> {
  const rows = await dbQuery('SELECT email, reason FROM suppressions WHERE workspace_id = ?', [workspaceId]);
  const map = new Map<string, string>();
  for (const r of rows) map.set(String(r.email).toLowerCase(), String(r.reason));
  return map;
}
