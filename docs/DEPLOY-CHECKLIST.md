# WorkMail — Host deploy checklist (Vercel + flow99.in)

Use this checklist for a host deploy. Each step is marked **Host** (done by the deployer, Flow99) or **User** (done by the end user). Values (keys, tokens, IDs) are never written in docs — they live in Vercel env vars, Wrangler secrets and the provider dashboards.

## 1. Cloudflare — database and attachments [Host]
- [ ] Create the D1 database: `npx wrangler d1 create workmail` — note the database ID.
- [ ] Apply the schema and seed to the live database:
  ```bash
  npx wrangler d1 execute workmail --remote --file=db/schema.sql
  npx wrangler d1 execute workmail --remote --file=db/seed.sql
  ```
- [ ] Create the KV namespace: `npx wrangler kv namespace create workmail_attachments` — note the namespace ID.
- [ ] Create a scoped Cloudflare API token (D1 edit, KV edit, Zone DNS edit). Never use a global API key.

## 2. Google Cloud — OAuth client [Host]
- [ ] Create an OAuth client of type **Web application**.
- [ ] Add the authorized redirect URI `{APP_URL}/auth/callback` (for example `https://flow99.in/auth/callback`, or the Vercel URL during staging).
- [ ] Note the client ID and secret for Vercel (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

## 3. Vercel — import, env, deploy [Host]
- [ ] Import `raj3kk/workmail` in Vercel. Framework: Next.js. Root Directory: `./` (repo root is the app root).
- [ ] Set the host env vars from the root `.env.example` (names only — values never in docs): `NEXT_PUBLIC_APP_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, `INBOUND_WEBHOOK_TOKEN`, `DELIVERY_WEBHOOK_TOKEN`, `OPS_CRON_TOKEN`, `PLATFORM_ADMIN_EMAILS`, `MFA_ENFORCEMENT`.
- [ ] Deploy and verify the build passes (`npm ci`, `npm run typecheck`, `npm run build`).

## 4. Cloudflare — inbound email worker [Host]
- [ ] Deploy the inbound Email Worker from `cloudflare/inbound-email-worker/`.
- [ ] Set the Worker variable `WORKMAIL_API_URL` (app origin, no trailing slash) and the Worker secret `INBOUND_WEBHOOK_TOKEN` (same value as Vercel).
- [ ] Configure the Cloudflare Email Routing route for `flow99.in` to deliver to the Worker.

## 5. DNS for flow99.in [Host + User]
- [ ] Publish MX records for Cloudflare Email Routing. [Host]
- [ ] Publish one SPF TXT record at the root (merge all authorized mechanisms; never two SPF records). [Host]
- [ ] Publish DKIM records exactly as shown in each sending provider's dashboard. [Host]
- [ ] Publish DMARC at `_dmarc.flow99.in` (start monitoring, tighten after review). [Host]
- [ ] Publish the `_workmail-verification` TXT record shown in Settings and click Verify in the app. [User — in Settings; host confirms]
- [ ] Verify the sender/domain in each provider's own dashboard. [User]
- [ ] Record values come from the app and provider dashboards at deploy time — never copy values from a guide.

## 6. App — first login, domain, mailbox, test [Host + User]
- [ ] First login with Google using an email listed in `PLATFORM_ADMIN_EMAILS`; confirm `/admin` access. [Host]
- [ ] Create the domain `flow99.in` in Settings. [Host]
- [ ] Create the mailbox `hello@flow99.in` (and `support@flow99.in` as needed) via the Settings UI. [Host]
- [ ] Enter provider API keys in Settings → Providers (per-workspace, encrypted server-side, never shown again). [User]
- [ ] Send test: inbound from an external address to `hello@flow99.in`, and outbound from WorkMail to an external address. [User]
- [ ] Confirm the inbound message lands only in the intended mailbox. [Host]

## 7. Workflows — backup/monitor and restore drill [Host]
- [ ] Set GitHub secrets for the backup workflow (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `AGE_RECIPIENT`) and the monitor workflow (`WORKMAIL_APP_URL`, `OPS_CRON_TOKEN`).
- [ ] Run the backup workflow once and confirm the age-encrypted D1 + KV exports land as GitHub Actions artifacts.
- [ ] Run the restore drill (`npm run restore:drill`) against a **staging** D1 database — never production — and confirm the restore succeeds.
- [ ] Confirm the monitor workflow polls the health endpoint and alerts fire.
