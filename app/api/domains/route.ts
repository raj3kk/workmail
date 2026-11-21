import {NextResponse} from 'next/server';
import {z} from 'zod';
import {randomBytes} from 'node:crypto';
import {resolveTxt, resolveMx} from 'node:dns/promises';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, listWorkspaceIds} from '@/lib/guards';

function stripToken(row: Record<string, any>): Record<string, any> {
  const {verification_token: _t, ...rest} = row;
  return rest;
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const ids = await listWorkspaceIds(user.id);
  if (!ids.length) return NextResponse.json({data: []});
  const rows = await dbQuery(
    `SELECT id, workspace_id, domain, ownership_status, dns_status, created_at FROM domains
     WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`,
    ids,
  );
  return NextResponse.json({data: rows});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      domain: z
        .string()
        .min(3)
        .max(253)
        .transform((v) => v.toLowerCase().replace(/\.$/, ''))
        .refine(
          (v) => /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v),
          {message: 'Invalid domain'},
        ),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Enter a valid domain name'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Admin access required'}, {status: 403});
  const token = randomBytes(24).toString('hex');
  const id = newId();
  const now = nowIso();
  try {
    await dbRun(
      'INSERT INTO domains (id, workspace_id, domain, ownership_status, dns_status, verification_token, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, p.data.workspace_id, p.data.domain, 'pending', 'pending', token, user.id, now],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not create domain'}, {status: 400});
  }
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), p.data.workspace_id, user.id, 'domain.created', 'domain', id, now],
  );
  const data = await dbOne('SELECT * FROM domains WHERE id = ?', [id]);
  return NextResponse.json(
    {data: data ? stripToken(data) : null, txt_host: `_workmail-verification.${p.data.domain}`, txt_value: `workmail-verification=${token}`},
    {status: 201},
  );
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({domain_id: z.string().uuid(), workspace_id: z.string().uuid()})
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Admin access required'}, {status: 403});
  const d = await dbOne('SELECT * FROM domains WHERE id = ? AND workspace_id = ?', [p.data.domain_id, p.data.workspace_id]);
  if (!d) return NextResponse.json({error: 'Domain not found'}, {status: 404});
  try {
    const records = await resolveTxt(`_workmail-verification.${d.domain}`);
    const expected = `workmail-verification=${d.verification_token}`;
    if (!records.flat().includes(expected))
      return NextResponse.json({error: 'Verification TXT record not found yet.'}, {status: 409});
    let dns_status = 'pending';
    try {
      const [mx, spf, dmarc] = await Promise.all([
        resolveMx(d.domain),
        resolveTxt(d.domain),
        resolveTxt(`_dmarc.${d.domain}`),
      ]);
      if (
        mx.length &&
        spf.flat().some((x) => x.toLowerCase().startsWith('v=spf1')) &&
        dmarc.flat().some((x) => x.toLowerCase().startsWith('v=dmarc1'))
      )
        dns_status = 'verified';
    } catch {
      // DNS lookups for MX/SPF/DMARC are best-effort; ownership is verified.
    }
    await dbRun('UPDATE domains SET ownership_status = ?, dns_status = ? WHERE id = ?', ['verified', dns_status, d.id]);
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), d.workspace_id, user.id, 'domain.verified', 'domain', d.id, nowIso()],
    );
    const data = await dbOne('SELECT * FROM domains WHERE id = ?', [d.id]);
    return NextResponse.json({data: data ? stripToken(data) : null});
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'DNS lookup failed'}, {status: 409});
  }
}
