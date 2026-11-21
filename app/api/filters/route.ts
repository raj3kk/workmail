import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {validateRuleInput} from '@/lib/filters';

// GET /api/filters?workspace_id=…[&mailbox_id=…] — list mail rules.
// POST — create a rule (owner/admin). PATCH — update name/conditions/
// actions/is_enabled. DELETE — remove a rule. Rules are evaluated on
// inbound mail by lib/filters.ts (see applyMailRules); a rule with no
// conditions match never fires, and a disabled rule never runs.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const wid = u.searchParams.get('workspace_id');
  const mailboxId = u.searchParams.get('mailbox_id');
  if (!wid) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  if (!(await workspaceRole(user.id, wid)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const params: unknown[] = [wid];
  let sql = 'SELECT id, workspace_id, mailbox_id, name, conditions, actions, is_enabled, created_at FROM mail_rules WHERE workspace_id = ?';
  if (mailboxId) {
    sql += ' AND mailbox_id = ?';
    params.push(mailboxId);
  }
  sql += ' ORDER BY created_at ASC';
  const rules = await dbQuery(sql, params);
  return NextResponse.json({rules});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.workspace_id || typeof b.name !== 'string' || !b.name.trim())
    return NextResponse.json({error: 'workspace_id and rule name required'}, {status: 400});
  const role = await workspaceRole(user.id, b.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  const err = validateRuleInput(b.conditions, b.actions);
  if (err) return NextResponse.json({error: err}, {status: 400});
  if (b.mailbox_id) {
    const box = await dbOne('SELECT id FROM mailboxes WHERE id = ? AND workspace_id = ?', [b.mailbox_id, b.workspace_id]);
    if (!box) return NextResponse.json({error: 'mailbox_id does not belong to this workspace'}, {status: 400});
  }
  const id = newId();
  try {
    await dbRun(
      'INSERT INTO mail_rules (id, workspace_id, mailbox_id, name, conditions, actions, is_enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [id, b.workspace_id, b.mailbox_id || null, b.name.trim().slice(0, 120), jstr(b.conditions), jstr(b.actions), user.id, nowIso()],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not create rule'}, {status: 400});
  }
  const rule = await dbOne('SELECT * FROM mail_rules WHERE id = ?', [id]);
  return NextResponse.json({rule});
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({error: 'id required'}, {status: 400});
  const rule = await dbOne('SELECT workspace_id FROM mail_rules WHERE id = ?', [b.id]);
  if (!rule) return NextResponse.json({error: 'Rule not found'}, {status: 404});
  const role = await workspaceRole(user.id, String(rule.workspace_id));
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof b.name === 'string' && b.name.trim()) {
    sets.push('name = ?');
    values.push(b.name.trim().slice(0, 120));
  }
  if (b.conditions !== undefined || b.actions !== undefined) {
    const cur = await dbOne('SELECT conditions, actions FROM mail_rules WHERE id = ?', [b.id]);
    let conditions: unknown = b.conditions;
    let actions: unknown = b.actions;
    try {
      if (conditions === undefined) conditions = JSON.parse(String(cur?.conditions || '{}'));
      if (actions === undefined) actions = JSON.parse(String(cur?.actions || '{}'));
    } catch {
      return NextResponse.json({error: 'Stored rule JSON is malformed'}, {status: 500});
    }
    const err = validateRuleInput(conditions, actions);
    if (err) return NextResponse.json({error: err}, {status: 400});
    sets.push('conditions = ?', 'actions = ?');
    values.push(jstr(conditions), jstr(actions));
  }
  if (typeof b.is_enabled === 'boolean') {
    sets.push('is_enabled = ?');
    values.push(b.is_enabled ? 1 : 0);
  }
  if (sets.length === 0) return NextResponse.json({error: 'Nothing to update'}, {status: 400});
  values.push(b.id);
  await dbRun(`UPDATE mail_rules SET ${sets.join(', ')} WHERE id = ?`, values);
  const updated = await dbOne('SELECT * FROM mail_rules WHERE id = ?', [b.id]);
  return NextResponse.json({rule: updated});
}

export async function DELETE(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({error: 'id required'}, {status: 400});
  const rule = await dbOne('SELECT workspace_id FROM mail_rules WHERE id = ?', [b.id]);
  if (!rule) return NextResponse.json({error: 'Rule not found'}, {status: 404});
  const role = await workspaceRole(user.id, String(rule.workspace_id));
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  await dbRun('DELETE FROM mail_rules WHERE id = ?', [b.id]);
  return NextResponse.json({success: true});
}
