import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {encryptSecret} from '@/lib/crypto';
import {requireUser, workspaceRole} from '@/lib/guards';
import {AI_DRAFT_MODELS, isAiDraftModel, listAiKeys, type AiDraftProvider} from '@/lib/ai-draft';

export const runtime = 'nodejs';

// Session-authenticated AI-drafting key management (Settings → AI keys).
// The plaintext key is NEVER stored, NEVER returned by any GET, NEVER
// logged — only the AES-256-GCM ciphertext (lib/crypto.ts) lives in
// D1. GET returns provider / model / last4 / created_at only.
// Create/delete/model-change require workspace owner or admin role.

const saveSchema = z.object({
  workspace_id: z.string().uuid(),
  provider: z.enum(['gemini', 'groq']),
  api_key: z.string().min(10).max(500),
  model: z.string().min(1).max(120),
});

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const keys = await listAiKeys(workspaceId);
  return NextResponse.json({keys, models: AI_DRAFT_MODELS});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid key request', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const provider = d.provider as AiDraftProvider;
  if (!isAiDraftModel(provider, d.model))
    return NextResponse.json(
      {error: `Model "${d.model}" is not available for ${provider}. Pick a current model from the list.`},
      {status: 400},
    );
  const role = await workspaceRole(user.id, d.workspace_id);
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can save AI keys.'}, {status: 403});
  const apiKey = d.api_key.trim();
  const last4 = apiKey.slice(-4);
  let encrypted: string;
  try {
    encrypted = encryptSecret(apiKey);
  } catch {
    return NextResponse.json({error: 'Key encryption is not configured on the server.'}, {status: 500});
  }
  const id = newId();
  const now = nowIso();
  // One key per (workspace, provider): saving again replaces it.
  await dbRun(
    `INSERT INTO ai_provider_keys (id, workspace_id, provider, key_encrypted, model, last4, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider) DO UPDATE SET key_encrypted = excluded.key_encrypted, model = excluded.model, last4 = excluded.last4, created_by = excluded.created_by, created_at = excluded.created_at`,
    [id, d.workspace_id, provider, encrypted, d.model, last4, user.id, now],
  );
  const row = await dbQuery(
    'SELECT id, workspace_id, provider, model, last4, created_at FROM ai_provider_keys WHERE workspace_id = ? AND provider = ? LIMIT 1',
    [d.workspace_id, provider],
  );
  const saved = row[0];
  return NextResponse.json(
    {
      key: saved
        ? {id: String(saved.id), provider, model: String(saved.model), last4: String(saved.last4), created_at: String(saved.created_at)}
        : {id, provider, model: d.model, last4, created_at: now},
    },
    {status: 201},
  );
}
