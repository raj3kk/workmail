// WorkMail email templates — server-side only (D1).
//
// Rendering happens ONLY here, on the server. The client never builds
// HTML: the Templates page previews with sample values, and the send
// path (lib/service-send.ts) renders the stored template at send time.
// Raw caller `html` is never forwarded verbatim again.
//
// Variables: {{name}}, {{otp}}, {{action_url}}, {{sender_name}},
// {{unsubscribe_url}}, {{email}} — plus, for bulk sends, any recipient
// column (e.g. {{company}}). An unknown variable is left visible as
// {{name}} in preview and REJECTED at send time with a clear error —
// never silently dropped, never rendered empty.
//
// Sanitisation: allowlist on save AND re-sanitised at render. Allowed
// tags are table layout + basic text + links + images; <script>,
// <style>, event handlers, javascript: URLs and external CSS are
// stripped. No secrets: templates contain no secrets and render never
// interpolates env values, tokens, or internal IDs — only the explicit
// context object passed by the caller.
//
// "3D" (D2): real 3D/WebGL/JS does not run in Gmail/Outlook/Apple Mail.
// The designs below get their depth from layered background colours,
// borders and padding in plain table layout with inline CSS — the only
// depth email clients actually render. docs/TEMPLATES.md says so.
import {dbOne, dbQuery, dbRun, jparse, jstr, newId, nowIso} from '@/lib/db';

export const TEMPLATE_CATEGORIES = ['auth', 'welcome', 'notification', 'newsletter', 'transactional'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  auth: 'Verification / OTP',
  welcome: 'Welcome',
  notification: 'Notification',
  newsletter: 'Newsletter / bulk',
  transactional: 'Transactional / reply',
};

/** Variables a template may use. Bulk sends additionally allow any recipient column. */
export const TEMPLATE_VARIABLES = ['name', 'otp', 'action_url', 'sender_name', 'unsubscribe_url', 'email'] as const;

export interface EmailTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  category: TemplateCategory;
  subject: string;
  html_body: string;
  text_body: string;
  variables: string[];
  is_default: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** All {{variable}} names in a string, lowercased, deduped. */
export function extractTemplateVariables(text: string): string[] {
  const found = new Set<string>();
  for (const m of (text || '').matchAll(PLACEHOLDER_RE)) found.add(m[1].toLowerCase());
  return [...found];
}

export class UnknownTemplateVariableError extends Error {
  variables: string[];
  constructor(variables: string[]) {
    super(
      `Template uses unknown variable(s): ${variables.map((v) => `{{${v}}}`).join(', ')}. ` +
        `Provide a value for each one or remove it from the template — values are never guessed or dropped silently.`,
    );
    this.name = 'UnknownTemplateVariableError';
    this.variables = variables;
  }
}

export type TemplateContext = Record<string, string>;

/**
 * Render one string against a context.
 * - strict=false (preview): unknown variables stay visible as {{name}}.
 * - strict=true (send time): unknown variables throw UnknownTemplateVariableError.
 * Context keys are matched case-insensitively; values are inserted as-is
 * (template HTML is sanitised separately — values come from the caller,
 * never from the template author, and the send path HTML-escapes the
 * variable values it inserts into HTML; see renderTemplateHtml).
 */
export function renderTemplateText(
  template: string,
  ctx: TemplateContext,
  strict: boolean,
): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) lower[k.toLowerCase()] = v;
  const unknown: string[] = [];
  const out = (template || '').replace(PLACEHOLDER_RE, (_whole, key: string) => {
    const v = lower[key.toLowerCase()];
    if (v === undefined) {
      if (!unknown.includes(key.toLowerCase())) unknown.push(key.toLowerCase());
      return `{{${key.toLowerCase()}}}`;
    }
    return v;
  });
  if (strict && unknown.length > 0) throw new UnknownTemplateVariableError(unknown);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render template HTML for sending: variable values are HTML-escaped
 * before insertion (a value must never be able to inject markup), then
 * the result is re-sanitised. Strict: unknown variables throw.
 */
export function renderTemplateHtml(html: string, ctx: TemplateContext, strict: boolean): string {
  const escaped: TemplateContext = {};
  for (const [k, v] of Object.entries(ctx)) escaped[k] = escapeHtml(v);
  return sanitizeTemplateHtml(renderTemplateText(html, escaped, strict));
}

// ---------------------------------------------------------------------------
// Sanitiser (allowlist, no dependencies)
// ---------------------------------------------------------------------------

const ALLOWED_TAGS: Record<string, string[]> = {
  table: ['width', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'align', 'style', 'role'],
  tbody: ['style'],
  thead: ['style'],
  tfoot: ['style'],
  tr: ['style', 'bgcolor', 'align', 'valign'],
  td: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'style'],
  th: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'style'],
  div: ['align', 'style'],
  span: ['style'],
  p: ['align', 'style'],
  h1: ['align', 'style'],
  h2: ['align', 'style'],
  h3: ['align', 'style'],
  a: ['href', 'title', 'style'],
  img: ['src', 'alt', 'width', 'height', 'style'],
  br: [],
  hr: ['style'],
  ul: ['style'],
  ol: ['style'],
  li: ['style'],
  strong: ['style'],
  b: ['style'],
  em: ['style'],
  i: ['style'],
  u: ['style'],
  small: ['style'],
  blockquote: ['style'],
  center: [],
};

// Tags whose whole element (tags + inner content) is dropped.
const DROP_ELEMENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'video', 'audio', 'link', 'meta', 'base', 'title',
  'svg', 'canvas', 'noscript', 'frame', 'frameset', 'applet',
]);

function sanitizeStyle(style: string): string {
  let s = style.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop declarations that can execute code or load remote CSS.
  s = s
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      if (!d) return false;
      const low = d.toLowerCase();
      if (low.includes('expression(')) return false;
      if (low.includes('javascript:')) return false;
      if (low.includes('vbscript:')) return false;
      if (low.includes('behavior:')) return false;
      if (low.includes('@import')) return false;
      if (low.includes('position:fixed')) return false;
      if (/url\(\s*['"]?\s*data:/.test(low)) return false;
      return true;
    })
    .join('; ');
  return s;
}

function sanitizeUrl(url: string, allowMailto: boolean): string | null {
  const u = url.trim().replace(/[\u0000-\u0020]+/g, '');
  // A bare {{variable}} is a template value, not a URL yet: it is kept
  // here and re-checked after render, when it holds the real URL.
  if (/^\{\{\s*[A-Za-z0-9_]+\s*\}\}$/.test(u)) return u;
  const low = u.toLowerCase();
  if (low.startsWith('javascript:') || low.startsWith('vbscript:') || low.startsWith('data:')) return null;
  if (low.startsWith('https://') || low.startsWith('http://')) return u;
  if (allowMailto && (low.startsWith('mailto:') || low.startsWith('tel:'))) return u;
  if (u.startsWith('#')) return u;
  return null;
}

/**
 * Allowlist HTML sanitiser. Unknown tags are unwrapped (their text is
 * kept, the tag is dropped); DROP_ELEMENT tags lose their content too.
 * Event-handler attributes (on*) and unsafe URLs are stripped. Inline
 * styles survive only after sanitizeStyle. Returns safe HTML.
 */
export function sanitizeTemplateHtml(html: string): string {
  let src = String(html || '');
  // Strip comments first — they can hide tags from naive parsers.
  src = src.replace(/<!--[\s\S]*?-->/g, '');
  // Drop whole dangerous elements including inner content.
  for (const tag of DROP_ELEMENT) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    src = src.replace(re, '');
    src = src.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  // Walk remaining tags.
  return src.replace(/<\/?([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g, (whole, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    const isClose = whole.startsWith('</');
    const allowed = ALLOWED_TAGS[tag];
    if (!allowed) return ''; // unwrap unknown tag, keep its text
    if (isClose) return `</${tag}>`;
    const attrs: string[] = [];
    const attrRe = /([A-Za-z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      if (name.startsWith('on')) continue; // event handlers never survive
      if (!allowed.includes(name)) continue;
      let value = m[2];
      const quoted = value.startsWith('"') || value.startsWith("'");
      if (quoted) value = value.slice(1, -1);
      if (name === 'href') {
        const safe = sanitizeUrl(value, true);
        if (safe === null) continue;
        value = safe;
      } else if (name === 'src') {
        const safe = sanitizeUrl(value, false);
        if (safe === null) continue;
        value = safe;
      } else if (name === 'style') {
        value = sanitizeStyle(value);
        if (!value) continue;
      } else {
        value = escapeHtml(value);
      }
      attrs.push(`${name}="${escapeHtml(value).replace(/"/g, '&quot;')}"`);
    }
    const selfClose = tag === 'br' || tag === 'hr' || tag === 'img';
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' /' : ''}>`;
  });
}

// ---------------------------------------------------------------------------
// Plain-text derivation
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Derive the plain-text part from HTML (providers need both parts). */
export function htmlToText(html: string): string {
  let s = String(html || '');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, text: string) => {
    const t = text.replace(/<[^>]*>/g, '').trim();
    return t ? `${t} (${href})` : href;
  });
  s = s.replace(/<(br|p|div|tr|li|h[1-3])\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-3]|table)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

// ---------------------------------------------------------------------------
// Unsubscribe footer + brand derivation (D3 helpers live in service-send;
// this file owns the footer markup + the mailto builder used by both)
// ---------------------------------------------------------------------------

/** mailto: unsubscribe address for a sender — no endpoint needed, and a
 *  mailto: List-Unsubscribe is honoured by Gmail/Outlook. */
export function buildUnsubscribeMailto(fromAddress: string): string {
  return `mailto:${fromAddress}?subject=Unsubscribe`;
}

/** Footer block appended to template/bulk HTML that does not already
 *  carry an unsubscribe link. `unsubscribeUrl` is a mailto: link. */
export function unsubscribeFooterHtml(senderName: string, unsubscribeUrl: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:1px solid #dbe4f0;">` +
    `<tr><td style="padding:16px 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#7a8aa5;">` +
    `You received this email from ${escapeHtml(senderName)}. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#2e4a9e;">Unsubscribe</a>` +
    `</td></tr><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#9aa8c0;">Sent via WorkMail</td></tr></table>`
  );
}

export function unsubscribeFooterText(senderName: string, unsubscribeUrl: string): string {
  return `\n\n—\nYou received this email from ${senderName}.\nUnsubscribe: ${unsubscribeUrl}\nSent via WorkMail`;
}

/** Brand part of a domain: flow99.in -> Flow99, my-shop.co -> Myshop. */
export function deriveBrandFromDomain(domain: string): string {
  const first = (domain || '').split('.')[0].replace(/[^A-Za-z0-9]/g, '');
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ---------------------------------------------------------------------------
// Default templates (seeded on first Templates visit)
// ---------------------------------------------------------------------------

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://workmail-delta.vercel.app').replace(/\/$/, '');
}

function wrapTemplate(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  ctaUrl?: string;
  ctaLabel?: string;
}): string {
  const logo = `${appBaseUrl()}/email-logo.png`;
  const cta = opts.ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;"><tr><td align="center" bgcolor="#2e4a9e" style="border-radius:8px;border:1px solid #22367a;"><a href="${opts.ctaUrl}" style="display:inline-block;padding:13px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${opts.ctaLabel || 'Continue'}</a></td></tr></table>`
    : '';
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f8;margin:0;padding:0;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #dbe4f0;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="background-color:#1f2a5c;padding:24px 28px;border-bottom:4px solid #2e4a9e;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td><img src="${logo}" alt="{{sender_name}}" width="44" height="44" style="display:block;border-radius:10px;" /></td>` +
    `<td style="padding-left:14px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#ffffff;">{{sender_name}}</td>` +
    `</tr></table></td></tr>` +
    `<tr><td style="padding:28px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;line-height:30px;color:#16233d;">${opts.heading}</td></tr>` +
    `<tr><td style="padding:8px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#33415e;">${opts.bodyHtml}${cta}</td></tr>` +
    `<tr><td style="padding:8px 28px 28px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #dbe4f0;"><tr><td style="padding:16px 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#7a8aa5;">You received this email from {{sender_name}}. <a href="{{unsubscribe_url}}" style="color:#2e4a9e;">Unsubscribe</a></td></tr><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#9aa8c0;">Sent via WorkMail</td></tr></table></td></tr>` +
    `</table></td></tr></table>` +
    `<span style="display:none;">${opts.preheader}</span>`
  );
}

export interface DefaultTemplateSpec {
  name: string;
  category: TemplateCategory;
  subject: string;
  html_body: string;
  text_body: string;
}

export function defaultTemplates(): DefaultTemplateSpec[] {
  return [
    {
      name: 'Default verification code',
      category: 'auth',
      subject: 'Your verification code is {{otp}}',
      html_body: wrapTemplate({
        preheader: 'Your verification code',
        heading: 'Your verification code',
        bodyHtml:
          `<p style="margin:0 0 16px 0;">Hi {{name}},</p>` +
          `<p style="margin:0 0 16px 0;">Use the code below to verify your account. It expires in 10 minutes — never share it with anyone.</p>` +
          `<p style="margin:0 0 16px 0;text-align:center;"><span style="display:inline-block;padding:14px 28px;background-color:#eef2f8;border:1px solid #dbe4f0;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:bold;letter-spacing:6px;color:#16233d;">{{otp}}</span></p>` +
          `<p style="margin:0;">If you did not request this code, you can safely ignore this email.</p>`,
        ctaUrl: '{{action_url}}',
        ctaLabel: 'Verify now',
      }),
      text_body: '',
    },
    {
      name: 'Default welcome',
      category: 'welcome',
      subject: 'Welcome to {{sender_name}}, {{name}}',
      html_body: wrapTemplate({
        preheader: 'Welcome aboard',
        heading: 'Welcome, {{name}}!',
        bodyHtml:
          `<p style="margin:0 0 16px 0;">Thanks for joining {{sender_name}}. Your workspace is ready — you can send from your own domain, track delivery, and reach your audience without juggling providers.</p>` +
          `<p style="margin:0;">Here is what to do first: verify your domain, connect a sending provider, and send yourself a test email.</p>`,
        ctaUrl: '{{action_url}}',
        ctaLabel: 'Open your inbox',
      }),
      text_body: '',
    },
    {
      name: 'Default notification',
      category: 'notification',
      subject: 'New notification from {{sender_name}}',
      html_body: wrapTemplate({
        preheader: 'You have a new notification',
        heading: 'Something needs your attention',
        bodyHtml:
          `<p style="margin:0 0 16px 0;">Hi {{name}},</p>` +
          `<p style="margin:0 0 16px 0;">There is a new update on your {{sender_name}} workspace. Open it to see the details and take action if needed.</p>` +
          `<p style="margin:0;">If this was not expected, check your workspace activity.</p>`,
        ctaUrl: '{{action_url}}',
        ctaLabel: 'View details',
      }),
      text_body: '',
    },
    {
      name: 'Default newsletter',
      category: 'newsletter',
      subject: '{{sender_name}} newsletter',
      html_body: wrapTemplate({
        preheader: 'News from {{sender_name}}',
        heading: 'Hello {{name}}, here is what is new',
        bodyHtml:
          `<p style="margin:0 0 16px 0;">This is the {{sender_name}} newsletter. Share your update here — a launch, an offer, or news your readers will care about.</p>` +
          `<p style="margin:0 0 16px 0;">Keep it short, keep it useful, and always give readers one clear next step.</p>` +
          `<p style="margin:0;">Thank you for reading — we will be back with more soon.</p>`,
        ctaUrl: '{{action_url}}',
        ctaLabel: 'Read more',
      }),
      text_body: '',
    },
    {
      name: 'Default transactional',
      category: 'transactional',
      subject: 'A message from {{sender_name}}',
      html_body: wrapTemplate({
        preheader: 'A message from {{sender_name}}',
        heading: 'Hi {{name}},',
        bodyHtml:
          `<p style="margin:0 0 16px 0;">Thank you for getting in touch with {{sender_name}}. This email confirms we received your message and will get back to you shortly.</p>` +
          `<p style="margin:0;">If you need anything sooner, just reply to this email.</p>`,
        ctaUrl: '{{action_url}}',
        ctaLabel: 'View your message',
      }),
      text_body: '',
    },
  ];
}

// ---------------------------------------------------------------------------
// D1 access: load / seed / set-default (all workspace-scoped)
// ---------------------------------------------------------------------------

export function templateRowToApi(row: Record<string, unknown>): EmailTemplateRow {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    name: String(row.name || ''),
    category: row.category as TemplateCategory,
    subject: String(row.subject || ''),
    html_body: String(row.html_body || ''),
    text_body: String(row.text_body || ''),
    variables: jparse<string[]>(String(row.variables || '[]'), []),
    is_default: Number(row.is_default || 0),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

export async function listTemplates(workspaceId: string): Promise<EmailTemplateRow[]> {
  const rows = await dbQuery(
    'SELECT * FROM email_templates WHERE workspace_id = ? ORDER BY category ASC, is_default DESC, created_at ASC',
    [workspaceId],
  );
  return rows.map(templateRowToApi);
}

export async function getTemplate(workspaceId: string, templateId: string): Promise<EmailTemplateRow | null> {
  const row = await dbOne('SELECT * FROM email_templates WHERE id = ? AND workspace_id = ?', [templateId, workspaceId]);
  return row ? templateRowToApi(row) : null;
}

/** Seed one default per category per workspace, on first Templates visit. Idempotent. */
export async function ensureDefaultTemplates(workspaceId: string, userId: string | null): Promise<void> {
  const existing = await dbOne('SELECT COUNT(*) AS n FROM email_templates WHERE workspace_id = ?', [workspaceId]);
  if (Number(existing?.n || 0) > 0) return;
  const now = nowIso();
  for (const spec of defaultTemplates()) {
    const html = sanitizeTemplateHtml(spec.html_body);
    const text = spec.text_body || htmlToText(html);
    const variables = [...new Set([...extractTemplateVariables(spec.subject), ...extractTemplateVariables(html)])];
    await dbRun(
      `INSERT OR IGNORE INTO email_templates (id, workspace_id, name, category, subject, html_body, text_body, variables, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [newId(), workspaceId, spec.name, spec.category, spec.subject, html, text, jstr(variables), userId, now, now],
    );
  }
}

/** Set one template as the default for its category (unsets the others). */
export async function setDefaultTemplate(workspaceId: string, templateId: string): Promise<EmailTemplateRow | null> {
  const row = await getTemplate(workspaceId, templateId);
  if (!row) return null;
  await dbRun('UPDATE email_templates SET is_default = 0, updated_at = ? WHERE workspace_id = ? AND category = ?', [
    nowIso(),
    workspaceId,
    row.category,
  ]);
  await dbRun('UPDATE email_templates SET is_default = 1, updated_at = ? WHERE id = ? AND workspace_id = ?', [
    nowIso(),
    templateId,
    workspaceId,
  ]);
  return getTemplate(workspaceId, templateId);
}
