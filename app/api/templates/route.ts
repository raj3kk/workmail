// /api/templates — list (seeds defaults on first visit) + create.
// All routes are session-authenticated and workspace-scoped; a template
// id from another workspace is never visible here.
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {
  TEMPLATE_CATEGORIES,
  ensureDefaultTemplates,
  extractTemplateVariables,
  htmlToText,
  listTemplates,
  sanitizeTemplateHtml,
} from '@/lib/templates';

export const runtime = 'nodejs';

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  category: z.enum(TEMPLATE_CATEGORIES),
  subject: z.string().min(1).max(998),
  html_body: z.string().min(1).max(200000),
  text_body: z.string().max(100000).optional().default(''),
});

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id is required.'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  await ensureDefaultTemplates(workspaceId, user.id);
  const templates = await listTemplates(workspaceId);
  return NextResponse.json({templates});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid template', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const role = await workspaceRole(user.id, d.workspace_id);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const html = sanitizeTemplateHtml(d.html_body);
  if (!html.trim()) return NextResponse.json({error: 'Template HTML is empty after sanitisation.'}, {status: 400});
  const text = d.text_body.trim() ? d.text_body : htmlToText(html);
  const variables = [...new Set([...extractTemplateVariables(d.subject), ...extractTemplateVariables(html)])];
  const id = newId();
  const now = nowIso();
  await dbRun(
    `INSERT INTO email_templates (id, workspace_id, name, category, subject, html_body, text_body, variables, is_default, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, d.workspace_id, d.name.trim(), d.category, d.subject, html, text, jstr(variables), user.id, now, now],
  );
  const templates = await listTemplates(d.workspace_id);
  const created = templates.find((t) => t.id === id);
  return NextResponse.json({template: created}, {status: 201});
}
