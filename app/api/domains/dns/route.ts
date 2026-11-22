import {NextResponse} from 'next/server';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, isValidOrigin} from '@/lib/guards';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

async function txt(name: string): Promise<string[]> {
  const r = await fetch('https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=TXT', {cache: 'no-store'});
  if (!r.ok) throw new Error('DNS lookup failed');
  const j = await r.json();
  return (j.Answer || [])
    .filter((x: any) => x.type === 16)
    .map((x: any) => String(x.data).replace(/^"|"$/g, ''));
}

export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const limited = await withRateLimit({
    scope: 'write',
    subject: user.id,
    limit: RATE_LIMIT_DEFAULTS.write.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.write.windowSeconds,
  });
  if (limited) return limited;
  const b = await req.json().catch(() => null);
  if (!b?.domain_id) return NextResponse.json({error: 'domain_id required'}, {status: 400});
  const d = await dbOne('SELECT id, workspace_id, domain FROM domains WHERE id = ?', [b.domain_id]);
  if (!d) return NextResponse.json({error: 'Domain not found'}, {status: 404});
  const role = await workspaceRole(user.id, d.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  const selectors = (Array.isArray(b.dkim_selectors) ? b.dkim_selectors : ['default', 'google', 'selector1', 'selector2'])
    .map((s: string) => String(s).trim())
    .filter((s: string) => /^[\w-]{1,63}$/.test(s))
    .slice(0, 10);
  const dkim = [];
  for (const s of selectors) {
    const host = s + '._domainkey.' + d.domain;
    try {
      const records = await txt(host);
      dkim.push({selector: s, host, found: records.some((x) => /v=dkim1/i.test(x) && /p=/i.test(x)), records});
    } catch {
      dkim.push({selector: s, host, found: false, error: 'lookup failed'});
    }
  }
  const [spf, dmarc, mx] = await Promise.all([
    txt(d.domain).catch(() => [] as string[]),
    txt('_dmarc.' + d.domain).catch(() => [] as string[]),
    fetch('https://dns.google/resolve?name=' + encodeURIComponent(d.domain) + '&type=MX', {cache: 'no-store'})
      .then((r) => r.json())
      .catch(() => ({Answer: []})),
  ]);
  return NextResponse.json({
    domain: d.domain,
    spf: spf.some((x) => /v=spf1/i.test(x)),
    dmarc: dmarc.some((x) => /v=dmarc1/i.test(x)),
    mx: (mx.Answer || []).length > 0,
    dkim,
    checked_at: new Date().toISOString(),
  });
}

export async function PUT(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  // DNS writes hit the Cloudflare API: tighter cap than generic writes.
  const limited = await withRateLimit({scope: 'write', subject: user.id, limit: 10, windowSeconds: 60});
  if (limited) return limited;
  const b = await req.json().catch(() => null);
  if (!b?.domain_id || !['TXT', 'MX', 'CNAME'].includes(b.record_type) || !b.record_name || !b.record_content)
    return NextResponse.json({error: 'Valid domain_id, record_type, record_name and record_content required'}, {status: 400});
  const d = await dbOne(
    'SELECT id, workspace_id, domain, ownership_status, dns_status FROM domains WHERE id = ?',
    [b.domain_id],
  );
  if (!d) return NextResponse.json({error: 'Domain not found'}, {status: 404});
  const role = await workspaceRole(user.id, d.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  // G-15: prefer the DNS-scoped token (Zone DNS Write, flow99.in zone
  // only); fall back to the broad host token until the scoped token's
  // env var is set. See docs/SECURITY.md.
  const token = process.env.CLOUDFLARE_DNS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone)
    return NextResponse.json({error: 'Configure Cloudflare DNS credentials server-side'}, {status: 503});
  const name = String(b.record_name).slice(0, 253);
  const content = String(b.record_content).slice(0, 2000);
  if (d.ownership_status !== 'verified' || d.dns_status !== 'verified')
    return NextResponse.json({error: 'Verify domain ownership and email DNS before creating records'}, {status: 409});
  // record_name must belong to the domain stored in the DB — never trust a
  // client-supplied domain string.
  const dn = String(d.domain).toLowerCase();
  const nm = name.toLowerCase();
  if (nm !== dn && !nm.endsWith('.' + dn))
    return NextResponse.json({error: 'DNS record must belong to verified domain'}, {status: 400});
  const r = await fetch('https://api.cloudflare.com/client/v4/zones/' + zone + '/dns_records', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      type: b.record_type,
      name,
      content,
      ttl: Math.max(60, Math.min(86400, Number(b.ttl) || 3600)),
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success)
    return NextResponse.json(
      {
        error: 'Cloudflare rejected DNS change',
        details: ((j?.errors || []) as any[]).map((e) => String(e?.message || 'DNS change failed')).slice(0, 5),
      },
      {status: 400},
    );
  await dbRun(
    'INSERT INTO dns_change_log (id, workspace_id, domain_id, provider, action, record_name, record_type, record_content, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(), d.workspace_id, d.id, 'cloudflare', 'create', name, b.record_type, content, user.id, nowIso()],
  );
  // G-07: return ONLY the record's own id/type/name. The raw Cloudflare
  // record carries zone_id / zone_name and the full record body — none
  // of that leaves the server.
  const result = j.result || {};
  return NextResponse.json({
    success: true,
    record: {
      id: String(result.id || ''),
      type: String(result.type || b.record_type),
      name: String(result.name || name),
    },
  });
}
