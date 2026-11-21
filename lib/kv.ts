import {createHash, createHmac} from 'node:crypto';

// Cloudflare KV over the REST API — the no-card attachment store.
// Attachments use KV (the card-gated object-storage service is not used). KV free tier:
// 1 GB storage, 100k reads/day, 1,000 writes/day, 25 MB max value — which
// matches the 25 MB attachment cap. Attachments are fetched by exact key,
// so KV's key-value model fits; no listing is needed at runtime.
// Keys: `att/<workspaceId>/<mailboxId>/<uuid>-<safeName>`.

function cfg() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespace = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !namespace || !token)
    throw new Error('Cloudflare KV is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_KV_NAMESPACE_ID / CLOUDFLARE_API_TOKEN).');
  return {account, namespace, token};
}

const kvUrl = (key: string) => {
  const {account, namespace} = cfg();
  return `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`;
};

export async function kvPut(key: string, data: Buffer, contentType: string): Promise<void> {
  const {token} = cfg();
  const r = await fetch(kvUrl(key), {
    method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': contentType},
    body: new Uint8Array(data), signal: AbortSignal.timeout(30000),
  } as any);
  if (!r.ok) throw new Error(`KV upload failed (HTTP ${r.status})`);
}

export async function kvGet(key: string): Promise<Buffer | null> {
  const {token} = cfg();
  const r = await fetch(kvUrl(key), {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(30000)});
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV read failed (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export async function kvDelete(key: string): Promise<void> {
  const {token} = cfg();
  const r = await fetch(kvUrl(key), {method: 'DELETE', headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)});
  if (!r.ok && r.status !== 404) throw new Error(`KV delete failed (HTTP ${r.status})`);
}

// Direct KV read URL (for server-side download proxying). The attachment
// download route streams bytes through the app so the KV token never
// reaches the browser; do NOT expose this URL client-side.
export async function kvReadUrl(key: string): Promise<string> {
  return kvUrl(key);
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export {createHmac};
