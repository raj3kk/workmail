# Deploy the WorkMail inbound Email Worker

1. Deploy this directory with Wrangler (`wrangler deploy`).
2. Set Worker variable `WORKMAIL_API_URL` to the Vercel app origin — the
   deployed WorkMail app, e.g. `https://workmail.vercel.app` or the
   flow99.in app URL (no trailing slash). This worker POSTs every parsed
   message to `<WORKMAIL_API_URL>/api/inbound`.
3. Set secret `INBOUND_WEBHOOK_TOKEN` (`wrangler secret put
   INBOUND_WEBHOOK_TOKEN`) matching the Vercel environment variable
   exactly.
4. Ensure `postal-mime` is installed from this worker's `package.json`
   (the only dependency; no lockfile needed).
5. In the Cloudflare dashboard, Email Routing > Routing Rules, create a
   custom address / route that invokes this Email Worker. This is manual
   dashboard setup — there is no routing config in `wrangler.toml`.
6. The Worker forwards parsed message fields and the recipient address.
   The Vercel API (`/api/inbound`) resolves the recipient against an
   active mailbox; it does not trust client-supplied tenant IDs. (The
   Cloudflare api-worker sidecar does the same mailbox-address lookup in
   its own `/api/inbound`.)
7. Send a test email from an unrelated external mailbox. Confirm it is
   stored in exactly one target mailbox and cannot be read by another
   workspace user.

Do not expose the inbound token in browser code, DNS records, GitHub, or logs. Rotate the token in both Cloudflare and Vercel if it is exposed.
