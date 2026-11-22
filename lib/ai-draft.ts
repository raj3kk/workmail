// E4 — AI drafting BYOK (user's own Gemini / Groq keys).
//
// SEPARATE from the trained AI agent (lib/ai.ts / auto-reply /
// draft-reply): this is a drafting helper only. It never sends mail —
// it returns {subject, body} for the user to review and edit in
// compose (or bulk) before anything is sent.
//
// Key priority: user's own key (Gemini first if both set, else Groq)
// → else Cloudflare Workers AI via the existing lib/ai.ts path
// (if configured) → else a clear "add your key" message (no crash,
// no fake draft).
//
// Model catalogue verified against the providers' live model lists on
// 2026-11-22:
// - Gemini: the plan's gemini-2.5-flash / gemini-2.5-flash-lite /
//   gemini-2.0-flash are RETIRED (2.0 shut down 2026-06-01; 2.5-flash
//   deprecated, routes to gemini-3.5-flash-lite from 2026-12-01;
//   2.5-flash-lite access limited to prior users). Current stable
//   Flash models are gemini-3.8-flash, gemini-3.5-flash,
//   gemini-3.5-flash-lite, gemini-3.6-flash, gemini-3.1-flash-lite.
// - Groq: llama-3.3-70b-versatile, llama-3.1-8b-instant and
//   openai/gpt-oss-120b are all still listed as production models on
//   console.groq.com/docs/models (verified 2026-11-22); gpt-oss-20b
//   added as the smaller sibling.
// A stored model that is no longer in this catalogue fails the draft
// call with a clear message naming the model — never a silent
// fallback to a different model (the user chose it).
//
// Guards: 1,000-token output cap, 8s provider timeout, prompt is
// topic-only (never includes other users' mail content). Keys are
// decrypted server-side only, never logged, never returned.
import {dbQuery} from '@/lib/db';
import {decryptSecret} from '@/lib/crypto';
import {generateDraftText, sanitizeAiMarker, AiNotConfiguredError} from '@/lib/ai';

export type AiDraftProvider = 'gemini' | 'groq';

export interface AiDraftModelInfo {
  id: string;
  label: string;
  note?: string;
}

export const AI_DRAFT_MODELS: Record<AiDraftProvider, AiDraftModelInfo[]> = {
  gemini: [
    {id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'Newest stable Flash'},
    {id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash'},
    {id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: 'Cheapest, high volume'},
    {id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash'},
    {id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite'},
  ],
  groq: [
    {id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile'},
    {id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', note: 'Fastest'},
    {id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B'},
    {id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B'},
  ],
};

export function isAiDraftModel(provider: AiDraftProvider, model: string): boolean {
  return AI_DRAFT_MODELS[provider].some((m) => m.id === model);
}

export const AI_DRAFT_MAX_OUTPUT_TOKENS = 1000;
export const AI_DRAFT_TIMEOUT_MS = 8000;

export class AiDraftError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = 'AI_DRAFT_FAILED') {
    super(message);
    this.name = 'AiDraftError';
    this.status = status;
    this.code = code;
  }
}

/** Public shape of a saved key — never includes key material. */
export interface AiKeyRow {
  id: string;
  workspace_id: string;
  provider: AiDraftProvider;
  model: string;
  last4: string;
  created_at: string;
}

export async function listAiKeys(workspaceId: string): Promise<AiKeyRow[]> {
  const rows = await dbQuery(
    'SELECT id, workspace_id, provider, model, last4, created_at FROM ai_provider_keys WHERE workspace_id = ? ORDER BY provider ASC',
    [workspaceId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    workspace_id: String(r.workspace_id),
    provider: r.provider as AiDraftProvider,
    model: String(r.model),
    last4: String(r.last4 || ''),
    created_at: String(r.created_at),
  }));
}

interface DecryptedKey {
  provider: AiDraftProvider;
  model: string;
  key: string;
}

/** Load one provider's key for a workspace, decrypted. Throws
 *  AiDraftError if the stored model is no longer in the catalogue. */
async function loadDecryptedKey(workspaceId: string, provider: AiDraftProvider): Promise<DecryptedKey | null> {
  const rows = await dbQuery(
    'SELECT model, key_encrypted FROM ai_provider_keys WHERE workspace_id = ? AND provider = ? LIMIT 1',
    [workspaceId, provider],
  );
  if (!rows.length) return null;
  const model = String(rows[0].model);
  if (!isAiDraftModel(provider, model)) {
    throw new AiDraftError(
      `The saved model "${model}" for ${provider} is no longer available. Pick a current model in Settings → AI drafting keys.`,
      400,
      'MODEL_RETIRED',
    );
  }
  let key: string;
  try {
    key = decryptSecret(String(rows[0].key_encrypted));
  } catch {
    throw new AiDraftError(
      `The saved ${provider} key could not be decrypted. Delete it in Settings → AI drafting keys and add it again.`,
      500,
      'KEY_DECRYPT_FAILED',
    );
  }
  if (!key) return null;
  return {provider, model, key};
}

export type AiDraftTone = 'formal' | 'friendly' | 'short';

const TONE_LINES: Record<AiDraftTone, string> = {
  formal: 'Tone: formal and professional.',
  friendly: 'Tone: friendly and warm, still professional.',
  short: 'Tone: short and to the point — a few sentences at most.',
};

function buildDraftPrompt(input: {
  topic: string;
  tone: AiDraftTone;
  to?: string;
  subject?: string;
}): string {
  const lines = [
    'Write an email draft from the topic below. Draft only what the topic asks for.',
    'Never invent facts, dates, prices, order numbers, commitments, or meeting times.',
    'If the topic needs a fact you do not have, write [NEEDS HUMAN INPUT] at that spot instead of guessing.',
    'Do not add a sign-off with a person\u2019s name.',
    TONE_LINES[input.tone],
    `Topic / purpose: ${input.topic}`,
  ];
  if (input.to) lines.push(`Recipient: ${input.to}`);
  if (input.subject) lines.push(`Suggested subject: ${input.subject}`);
  lines.push(
    'Reply with exactly this shape, nothing else:',
    'Subject: <one subject line>',
    '',
    '<email body>',
  );
  return lines.join('\n');
}

/** Split a model reply into {subject, body}. Falls back to the
 *  caller's subject hint / topic when no "Subject:" line is present. */
function parseDraftReply(text: string, fallbackSubject: string): {subject: string; body: string} {
  // The model writes [NEEDS HUMAN INPUT] where it lacks a fact; that
  // marker leaked verbatim into a bulk AI draft on 2026-11-22. Show the
  // human a fill-in spot instead — never the internal token.
  const clean = sanitizeAiMarker((text || '').trim(), '[add details here]');
  const m = /^Subject:\s*(.+)$/m.exec(clean);
  if (m) {
    const subject = m[1].trim().slice(0, 200) || fallbackSubject;
    const body = clean
      .slice(m.index + m[0].length)
      .replace(/^\s+/, '')
      .trim();
    return {subject, body: body || clean};
  }
  return {subject: fallbackSubject, body: clean};
}

function isTimeoutError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === 'TimeoutError') ||
    (e instanceof Error && /timed out|aborted/i.test(e.message))
  );
}

async function callGemini(key: string, model: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {maxOutputTokens: AI_DRAFT_MAX_OUTPUT_TOKENS, temperature: 0.5},
      }),
      signal: AbortSignal.timeout(AI_DRAFT_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    if (isTimeoutError(e))
      throw new AiDraftError('Gemini timed out after 8 seconds. Try again.', 504, 'PROVIDER_TIMEOUT');
    throw new AiDraftError('Could not reach Gemini. Check your connection and try again.', 502, 'PROVIDER_UNREACHABLE');
  }
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = String(j?.error?.message || `HTTP ${r.status}`);
    if (r.status === 404 || /not found|not supported/i.test(detail))
      throw new AiDraftError(
        `Gemini model "${model}" was not found (it may have been retired). Pick a current model in Settings → AI drafting keys.`,
        400,
        'MODEL_RETIRED',
      );
    if (r.status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail))
      throw new AiDraftError(
        'Gemini rejected the saved key (invalid API key). Check the key in Settings → AI drafting keys.',
        401,
        'KEY_REJECTED',
      );
    if (r.status === 401 || r.status === 403)
      throw new AiDraftError(
        'Gemini rejected the saved key. Check the key in Settings → AI drafting keys.',
        401,
        'KEY_REJECTED',
      );
    throw new AiDraftError(`Gemini rejected the request (${detail}).`, 502, 'PROVIDER_ERROR');
  }
  const text = ((j?.candidates?.[0]?.content?.parts || []) as any[])
    .map((p) => String(p?.text || ''))
    .join('')
    .trim();
  if (!text) throw new AiDraftError('Gemini returned an empty draft.', 502, 'PROVIDER_EMPTY');
  return text;
}

async function callGroq(key: string, model: string, prompt: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        model,
        messages: [{role: 'user', content: prompt}],
        max_tokens: AI_DRAFT_MAX_OUTPUT_TOKENS,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(AI_DRAFT_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    if (isTimeoutError(e))
      throw new AiDraftError('Groq timed out after 8 seconds. Try again.', 504, 'PROVIDER_TIMEOUT');
    throw new AiDraftError('Could not reach Groq. Check your connection and try again.', 502, 'PROVIDER_UNREACHABLE');
  }
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = String(j?.error?.message || `HTTP ${r.status}`);
    if (r.status === 404 || /model.*not found|does not exist/i.test(detail))
      throw new AiDraftError(
        `Groq model "${model}" was not found (it may have been retired). Pick a current model in Settings → AI drafting keys.`,
        400,
        'MODEL_RETIRED',
      );
    if (r.status === 401)
      throw new AiDraftError(
        'Groq rejected the saved key (invalid API key). Check the key in Settings → AI drafting keys.',
        401,
        'KEY_REJECTED',
      );
    throw new AiDraftError(`Groq rejected the request (${detail}).`, 502, 'PROVIDER_ERROR');
  }
  const text = String(j?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new AiDraftError('Groq returned an empty draft.', 502, 'PROVIDER_EMPTY');
  return text;
}

export interface DraftWithAiInput {
  workspaceId: string;
  topic: string;
  tone: AiDraftTone;
  to?: string;
  subject?: string;
}

export interface DraftWithAiResult {
  subject: string;
  body: string;
  provider: AiDraftProvider | 'workers-ai';
  model: string;
}

/**
 * Generate a {subject, body} draft. Priority: user's own Gemini key,
 * then Groq key, then Workers AI (lib/ai.ts). No key anywhere = a
 * 503 naming the fix — never a crash, never a fake draft. The prompt
 * is topic-only: no other user's mail content is ever included.
 */
export async function draftWithAi(input: DraftWithAiInput): Promise<DraftWithAiResult> {
  const topic = (input.topic || '').trim();
  if (topic.length < 2 || topic.length > 1000)
    throw new AiDraftError('Topic must be between 2 and 1000 characters.', 400, 'BAD_TOPIC');
  const tone: AiDraftTone = input.tone === 'formal' || input.tone === 'friendly' || input.tone === 'short' ? input.tone : 'friendly';
  const fallbackSubject = (input.subject || '').trim().slice(0, 200) || topic.slice(0, 80);
  const prompt = buildDraftPrompt({topic, tone, to: input.to?.trim() || undefined, subject: input.subject?.trim() || undefined});

  // User's own keys first: Gemini, then Groq.
  for (const provider of ['gemini', 'groq'] as const) {
    const saved = await loadDecryptedKey(input.workspaceId, provider);
    if (!saved) continue;
    const text = provider === 'gemini' ? await callGemini(saved.key, saved.model, prompt) : await callGroq(saved.key, saved.model, prompt);
    const parsed = parseDraftReply(text, fallbackSubject);
    if (!parsed.body) throw new AiDraftError(`${provider} returned an empty draft.`, 502, 'PROVIDER_EMPTY');
    return {subject: parsed.subject, body: parsed.body, provider, model: saved.model};
  }

  // Fallback: Workers AI via the existing trained-agent path.
  try {
    const out = await generateDraftText(prompt, {workspaceId: input.workspaceId});
    const parsed = parseDraftReply(out.text, fallbackSubject);
    if (!parsed.body) throw new AiDraftError('Workers AI returned an empty draft.', 502, 'PROVIDER_EMPTY');
    return {subject: parsed.subject, body: parsed.body, provider: 'workers-ai', model: out.config.model};
  } catch (e) {
    if (e instanceof AiDraftError) throw e;
    if (e instanceof AiNotConfiguredError) {
      throw new AiDraftError(
        'Add your own Gemini/Groq key in Settings to use AI drafting.',
        503,
        'NO_KEY',
      );
    }
    throw new AiDraftError(
      `AI drafting failed (${e instanceof Error ? e.message : 'provider error'}). Add your own Gemini/Groq key in Settings to use AI drafting.`,
      502,
      'PROVIDER_ERROR',
    );
  }
}
