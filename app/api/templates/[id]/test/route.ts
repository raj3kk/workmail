// POST /api/templates/[id]/test — test-send one template to the user's
// own mailbox through the normal send pipeline (provider Auto, same
// idempotency / suppression / caps as a real send). The recipient is the
// signed-in user's own email unless `to` names another address the
// caller owns; the template renders with sample values (otp 123456,
// action_url = the app URL) so the received mail shows the real design.
import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {dbOne, dbQuery} from '@/lib/db';
import {canAccessMailbox, requireUser, workspaceRole} from '@/lib/guards';
import {executeSend} from '@/lib/service-send';
import {appBaseUrl, getTemplate} from '@/lib/templates';

export const runtime = 'nodejs';

const testSchema = z.object({
  workspace_id: z.string().uuid(),
  mailbox_id: z.string().uuid().optional(),
  to: z.string().email().optional(),
});

export async function POST(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = testSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid request', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  if (!(await workspaceRole(user.id, d.workspace_id)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const template = await getTemplate(d.workspace_id, params.id);
  if (!template) return NextResponse.json({error: 'Template not found.'}, {status: 404});
  const boxes = await dbQuery(
    'SELECT id, address, display_name, domain_id FROM mailboxes WHERE workspace_id = ? AND is_active = 1' +
      (d.mailbox_id ? ' AND id = ?' : '') +
      ' LIMIT 20',
    d.mailbox_id ? [d.workspace_id, d.mailbox_id] : [d.workspace_id],
  );
  let sender: Record<string, unknown> | null = null;
  for (const b of boxes) {
    if (await canAccessMailbox(user.id, String(b.id), true)) {
      sender = b;
      break;
    }
  }
  if (!sender)
    return NextResponse.json({error: 'No mailbox assigned to you with send permission.'}, {status: 403});
  const to = d.to || user.email;
  const name = (to.split('@')[0] || 'there').trim();
  const exec = await executeSend(
    {
      workspaceId: d.workspace_id,
      sender: {
        id: String(sender.id),
        address: String(sender.address),
        display_name: sender.display_name ? String(sender.display_name) : null,
        domain_id: String(sender.domain_id),
      },
      to,
      subject: template.subject,
      idempotencyKey: randomUUID(),
      provider: 'auto',
      templateId: params.id,
      variables: {name, otp: '123456', action_url: appBaseUrl()},
    },
    {kind: 'user', userId: user.id},
  );
  return NextResponse.json(exec.body, {status: exec.status});
}
