import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbRun} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {isAiDraftModel, type AiDraftProvider} from '@/lib/ai-draft';

export const runtime = 'nodejs';

// PATCH /api/ai/keys/[id] — change the stored model for a saved key.
// DELETE /api/ai/keys/[id] — revoke/delete the saved key (the encrypted
// value is removed from D1; the provider-side key itself is untouched).
// Both require workspace owner or admin role. Neither ever returns or
// logs key material.

const patchSchema = z.object({model: z.string().min(1).max(120)});

export async function PATCH(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({error: 'Invalid model'}, {status: 400});
  const row = await dbOne('SELECT id, workspace_id, provider FROM ai_provider_keys WHERE id = ?', [params.id]);
  if (!row) return NextResponse.json({error: 'AI key not found'}, {status: 404});
  const provider = String(row.provider) as AiDraftProvider;
  if (!isAiDraftModel(provider, parsed.data.model))
    return NextResponse.json(
      {error: `Model "${parsed.data.model}" is not available for ${provider}. Pick a current model from the list.`},
      {status: 400},
    );
  const role = await workspaceRole(user.id, String(row.workspace_id));
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can change AI keys.'}, {status: 403});
  await dbRun('UPDATE ai_provider_keys SET model = ? WHERE id = ?', [parsed.data.model, params.id]);
  return NextResponse.json({key: {id: params.id, provider, model: parsed.data.model}});
}

export async function DELETE(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const row = await dbOne('SELECT id, workspace_id FROM ai_provider_keys WHERE id = ?', [params.id]);
  if (!row) return NextResponse.json({error: 'AI key not found'}, {status: 404});
  const role = await workspaceRole(user.id, String(row.workspace_id));
  if (role !== 'owner' && role !== 'admin')
    return NextResponse.json({error: 'Only workspace owners and admins can delete AI keys.'}, {status: 403});
  await dbRun('DELETE FROM ai_provider_keys WHERE id = ?', [params.id]);
  return NextResponse.json({deleted: true});
}
