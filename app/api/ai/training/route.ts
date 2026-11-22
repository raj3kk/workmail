import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser, workspaceRole} from '@/lib/guards';
import {logAiAction} from '@/lib/ai';
import {
  TRAINING_KINDS,
  TrainingSecretError,
  addTrainingEntries,
  createTrainingEntry,
  deleteTrainingEntry,
  listTraining,
  parseUploadedTraining,
  updateTrainingEntry,
} from '@/lib/ai-training';

export const runtime = 'nodejs';

const workspaceSchema = z.object({workspace_id: z.string().uuid()});
const createSchema = z.object({
  workspace_id: z.string().uuid(),
  kind: z.enum(TRAINING_KINDS as [string, ...string[]]),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20000),
});
const uploadJsonSchema = z.object({
  workspace_id: z.string().uuid(),
  upload_text: z.string().min(1).max(200000),
  filename: z.string().min(1).max(200),
});
const updateSchema = z.object({
  workspace_id: z.string().uuid(),
  id: z.string().uuid(),
  kind: z.enum(TRAINING_KINDS as [string, ...string[]]).optional(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20000).optional(),
});
const deleteSchema = z.object({
  workspace_id: z.string().uuid(),
  id: z.string().uuid(),
});

async function requireMember(userId: string, workspaceId: string) {
  return (await workspaceRole(userId, workspaceId)) !== null;
}

async function requireOwnerOrAdmin(userId: string, workspaceId: string) {
  const role = await workspaceRole(userId, workspaceId);
  return role === 'owner' || role === 'admin';
}

function trainingSummary(entries: Awaited<ReturnType<typeof listTraining>>) {
  const updated = entries.map((e) => e.updated_at).sort().at(-1) || null;
  return {
    count: entries.length,
    has_profile: entries.some((e) => e.kind === 'profile'),
    updated_at: updated,
  };
}

function secretErrorResponse(e: unknown) {
  if (e instanceof TrainingSecretError)
    return NextResponse.json({error: e.message, code: 'TRAINING_SECRET_REJECTED'}, {status: 400});
  return null;
}

// GET /api/ai/training?workspace_id=… — list this workspace's training
// entries (any workspace member). Workspace-scoped: only the caller's own
// workspace key is ever read.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  const p = workspaceSchema.safeParse({workspace_id: workspaceId});
  if (!p.success) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  if (!(await requireMember(user.id, p.data.workspace_id)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const entries = await listTraining(p.data.workspace_id);
  return NextResponse.json({workspace_id: p.data.workspace_id, entries, ...trainingSummary(entries)});
}

// POST /api/ai/training — owner/admin only. Three shapes:
//   {workspace_id, kind, title, content} — add one pasted entry.
//   {workspace_id, upload_text, filename} — parse pasted file text
//     (.txt/.md/.csv rules) and add the resulting entries in one write.
//   multipart form-data with `file` (.txt/.md/.csv) + `workspace_id` —
//     the file is parsed server-side; nothing is stored raw.
// Entries that look like API keys / credentials are rejected (400
// TRAINING_SECRET_REJECTED) and nothing is stored.
export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const contentType = req.headers.get('content-type') || '';

  // --- Multipart file upload ---------------------------------------------
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({error: 'Could not read uploaded file'}, {status: 400});
    }
    const workspaceId = String(form.get('workspace_id') || '');
    const file = form.get('file');
    if (!workspaceSchema.safeParse({workspace_id: workspaceId}).success)
      return NextResponse.json({error: 'workspace_id required'}, {status: 400});
    if (!(await requireOwnerOrAdmin(user.id, workspaceId)))
      return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
    if (!file || typeof file === 'string' || !('text' in file))
      return NextResponse.json({error: 'No file uploaded (field name: file)'}, {status: 400});
    const filename = file.name || 'upload.txt';
    if (!/\.(txt|md|csv)$/i.test(filename))
      return NextResponse.json({error: 'Only .txt, .md and .csv files are accepted'}, {status: 400});
    try {
      const text = await file.text();
      const parsed = parseUploadedTraining(text, filename);
      const created = await addTrainingEntries(
        workspaceId,
        parsed.map((e) => ({...e, source: 'upload' as const, filename})),
        user.id,
      );
      await logAiAction({
        action: 'ai.training_uploaded',
        workspaceId,
        actorUserId: user.id,
        training: {count: created.length, entryIds: created.map((e) => e.id)},
      });
      const entries = await listTraining(workspaceId);
      return NextResponse.json({created, ...trainingSummary(entries)}, {status: 201});
    } catch (e) {
      return (
        secretErrorResponse(e) ||
        NextResponse.json({error: 'Upload failed'}, {status: 400})
      );
    }
  }

  // --- JSON bodies ---------------------------------------------------------
  const b = await req.json().catch(() => null);

  const upload = uploadJsonSchema.safeParse(b);
  if (upload.success) {
    if (!(await requireOwnerOrAdmin(user.id, upload.data.workspace_id)))
      return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
    try {
      const parsed = parseUploadedTraining(upload.data.upload_text, upload.data.filename);
      const created = await addTrainingEntries(
        upload.data.workspace_id,
        parsed.map((e) => ({...e, source: 'upload' as const, filename: upload.data.filename})),
        user.id,
      );
      await logAiAction({
        action: 'ai.training_uploaded',
        workspaceId: upload.data.workspace_id,
        actorUserId: user.id,
        training: {count: created.length, entryIds: created.map((e) => e.id)},
      });
      const entries = await listTraining(upload.data.workspace_id);
      return NextResponse.json({created, ...trainingSummary(entries)}, {status: 201});
    } catch (e) {
      return (
        secretErrorResponse(e) ||
        NextResponse.json({error: 'Upload failed'}, {status: 400})
      );
    }
  }

  const create = createSchema.safeParse(b);
  if (create.success) {
    if (!(await requireOwnerOrAdmin(user.id, create.data.workspace_id)))
      return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
    try {
      const entry = await createTrainingEntry(
        create.data.workspace_id,
        {
          kind: create.data.kind as (typeof TRAINING_KINDS)[number],
          title: create.data.title,
          content: create.data.content,
          source: 'paste',
        },
        user.id,
      );
      await logAiAction({
        action: 'ai.training_created',
        workspaceId: create.data.workspace_id,
        actorUserId: user.id,
        training: {count: 1, entryIds: [entry.id]},
      });
      return NextResponse.json({entry}, {status: 201});
    } catch (e) {
      return (
        secretErrorResponse(e) ||
        NextResponse.json({error: 'Could not save training entry'}, {status: 400})
      );
    }
  }

  return NextResponse.json({error: 'Invalid request'}, {status: 400});
}

// PATCH /api/ai/training — edit one entry (owner/admin only). The new
// text is secret-scanned again before anything is stored.
export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = updateSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  if (!(await requireOwnerOrAdmin(user.id, p.data.workspace_id)))
    return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
  try {
    const entry = await updateTrainingEntry(p.data.workspace_id, p.data.id, {
      kind: p.data.kind as (typeof TRAINING_KINDS)[number] | undefined,
      title: p.data.title,
      content: p.data.content,
    });
    if (!entry) return NextResponse.json({error: 'Training entry not found'}, {status: 404});
    await logAiAction({
      action: 'ai.training_updated',
      workspaceId: p.data.workspace_id,
      actorUserId: user.id,
      training: {count: 1, entryIds: [entry.id]},
    });
    return NextResponse.json({entry});
  } catch (e) {
    return (
      secretErrorResponse(e) ||
      NextResponse.json({error: 'Could not update training entry'}, {status: 400})
    );
  }
}

// DELETE /api/ai/training — delete one entry (owner/admin only).
export async function DELETE(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const url = new URL(req.url);
  const body = await req.json().catch(() => null);
  const p = deleteSchema.safeParse(
    body ?? {workspace_id: url.searchParams.get('workspace_id'), id: url.searchParams.get('id')},
  );
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  if (!(await requireOwnerOrAdmin(user.id, p.data.workspace_id)))
    return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
  const deleted = await deleteTrainingEntry(p.data.workspace_id, p.data.id);
  if (!deleted) return NextResponse.json({error: 'Training entry not found'}, {status: 404});
  await logAiAction({
    action: 'ai.training_deleted',
    workspaceId: p.data.workspace_id,
    actorUserId: user.id,
    training: {count: 1, entryIds: [p.data.id]},
  });
  return NextResponse.json({deleted: true, id: p.data.id});
}
