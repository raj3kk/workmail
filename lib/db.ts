import {randomUUID} from 'node:crypto';

// Cloudflare D1 access over the Cloudflare REST API.
// Works from any host (Vercel, Pages, local) with a single API token that has
// D1 edit permission. All SQL is parameterised; never interpolate values.
// Free-tier limits (2026-11-21, live-verified): 5 GB total, 5M rows read/day,
// 100K rows written/day, 10 databases. No card required.
export type Row = Record<string, any>;

function cfg() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !database || !token)
    throw new Error('Cloudflare D1 is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN).');
  return {account, database, token};
}

export function newId(): string { return randomUUID(); }
export function nowIso(): string { return new Date().toISOString(); }

async function callD1(body: unknown): Promise<any> {
  const {account, database, token} = cfg();
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15000)});
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const msg = j?.errors?.map((e: any) => e.message).join('; ') || `D1 request failed (HTTP ${r.status})`;
    throw new Error(msg);
  }
  return j.result?.[0];
}

export async function dbQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await callD1({sql, params});
  return (res?.results || []) as Row[];
}

export async function dbOne(sql: string, params: unknown[] = []): Promise<Row | null> {
  const rows = await dbQuery(sql, params);
  return rows[0] || null;
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<{changes: number}> {
  const res = await callD1({sql, params});
  return {changes: res?.meta?.changes ?? 0};
}

export async function dbBatch(statements: Array<{sql: string; params?: unknown[]}>): Promise<void> {
  // NOTE (live-verified 2026-11-21): the D1 /batch endpoint returns
  // 404 "Route not found" on this account, so batching is done as
  // sequential /query calls. Same atomicity caveat as any multi-statement
  // write: callers must not rely on all-or-nothing behaviour here.
  for (const st of statements) await callD1({sql: st.sql, params: st.params ?? []});
}

// Convenience: JSON columns are stored as TEXT in D1.
export const jstr = (v: unknown): string => JSON.stringify(v ?? {});
export const jparse = <T>(v: string | null | undefined, fallback: T): T => {
  if (!v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};
