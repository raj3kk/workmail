// Gmail backup mirror — disconnect (Phase 4, PRODUCTION-PLAN.md §7).
// Owner-only. Revokes the stored Google grant and deletes the D1 token row.
// Mirrored copies already in Gmail are NOT deleted (the user owns that
// mailbox); the D1 originals are untouched — D1 stays the source of truth.
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser, workspaceRole} from '@/lib/guards';
import {revokeGmailMirrorToken} from '@/lib/gmail-oauth';

export const runtime = 'nodejs';

const schema = z.object({workspace_id: z.string().min(1)});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({error: 'workspace_id is required'}, {status: 400});
  const workspaceId = parsed.data.workspace_id;
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const role = await workspaceRole(user.id, workspaceId);
  if (role !== 'owner')
    return NextResponse.json({error: 'Gmail backup is available to the workspace owner only.'}, {status: 403});
  await revokeGmailMirrorToken(workspaceId);
  return NextResponse.json({disconnected: true});
}
