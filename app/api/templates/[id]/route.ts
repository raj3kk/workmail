// /api/templates/[id] — read / update / delete one template.
// The template id alone proves nothing: every operation re-checks the
// row belongs to a workspace the caller is a member of. PATCH re-runs
// the save-time sanitiser and re-derives the variable list and the
// plain-text part. DELETE promotes the oldest remaining template of
// the same category to default when the deleted one was the default.
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbRun, jstr, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {
  TEMPLATE_CATEGORIES,
  extractTemplateVariables,
  getTemplate,
  htmlToText,
  sanitizeTemplateHtml,
  setDefaultTemplate,
} from '@/lib/templates';

export const runtime = 'nodejs';

const patchSchema = z.object({
  workspace_id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  subject: z.string().min(1).max(998).optional(),
  html_body: z.string().min(1).max(200000).optional(),
  text_body: z.string().max(100000).optional(),
  is_default: z.boolean().optional(),
});

export async function GET(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id is required.'}, {status: 400});
  if (!(await workspaceRole(user.id, workspaceId)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const template = await getTemplate(workspaceId, params.id);
  if (!template) return NextResponse.json({error: 'Template not found.'}, {status: 404});
  return NextResponse.json({template});
}

export async function PATCH(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid template', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  if (!(await workspaceRole(user.id, d.workspace_id)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const current = await getTemplate(d.workspace_id, params.id);
  if (!current) return NextResponse.json({error: 'Template not found.'}, {status: 404});
  const name = d.name !== undefined ? d.name.trim() : current.name;
  const category = d.category !== undefined ? d.category : current.category;
  const subject = d.subject !== undefined ? d.subject : current.subject;
  let html = d.html_body !== undefined ? sanitizeTemplateHtml(d.html_body) : current.html_body;
  if (d.html_body !== undefined && !html.trim())
    return NextResponse.json({error: 'Template HTML is empty after sanitisation.'}, {status: 400});
  let text = d.text_body !== undefined ? d.text_body : current.text_body;
  if (d.html_body !== undefined && d.text_body === undefined) text = htmlToText(html);
  const variables = [...new Set([...extractTemplateVariables(subject), ...extractTemplateVariables(html)])];
  await dbRun(
    `UPDATE email_templates SET name = ?, category = ?, subject = ?, html_body = ?, text_body = ?, variables = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [name, category, subject, html, text, jstr(variables), nowIso(), params.id, d.workspace_id],
  );
  let updated = await getTemplate(d.workspace_id, params.id);
  if (d.is_default === true && updated) updated = await setDefaultTemplate(d.workspace_id, params.id);
  return NextResponse.json({template: updated});
}

export async function DELETE(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id is required.'}, {status: 400});
  if (!(await workspaceRole(user.id, workspaceId)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const current = await getTemplate(workspaceId, params.id);
  if (!current) return NextResponse.json({error: 'Template not found.'}, {status: 404});
  await dbRun('DELETE FROM email_templates WHERE id = ? AND workspace_id = ?', [params.id, workspaceId]);
  // The deleted template was the category default: promote the oldest
  // remaining template of that category so the category keeps a default.
  if (current.is_default === 1) {
    const next = await dbOne(
      'SELECT id FROM email_templates WHERE workspace_id = ? AND category = ? ORDER BY created_at ASC LIMIT 1',
      [workspaceId, current.category],
    );
    if (next) await setDefaultTemplate(workspaceId, String(next.id));
  }
  return NextResponse.json({deleted: true});
}
