# WorkMail — User setup guide (end users only)

This guide is for the **end user** — the person using WorkMail mailboxes. It covers only what you do yourself. You do **not** need to connect an AI/browser agent, create a hosting account, or run any setup code.

## What the host already did for you

The host (Flow99) has already set up everything below. You do not need to do any of it, and you do not need accounts for any of it:

- The WorkMail app is deployed and running (Vercel).
- The database and attachment storage are created and live (Cloudflare D1 + KV).
- Inbound mail routing is deployed (Cloudflare Email Routing → inbound Email Worker → WorkMail).
- Google sign-in is configured.
- Backups and monitoring are running.

If any of those are not working, that is a host-side problem — report it to the host instead of trying to fix it yourself.

## What you need
- A Google account to sign in with.
- A domain name (for example `flow99.in`) and access to its DNS settings at your registrar/DNS host (GoDaddy, Namecheap, Cloudflare dashboard, etc.).
- At least one outbound email provider account (SendPulse, Brevo, Mailjet or Resend). More providers improve fallback resilience but are optional.
- A verified email address and MFA (authenticator app) for your WorkMail and provider accounts.

## Step 1 — Sign up with Google
1. Open the WorkMail app URL given to you by the host.
2. Click **Sign in with Google** and choose your Google account.
3. Your personal workspace is created automatically on first sign-in.
4. Set up TOTP MFA in your account settings using any authenticator app. Keep your recovery codes somewhere safe.

## Step 2 — Add your domain
1. In WorkMail, open **Settings → Domains → Add domain** and enter your domain (for example `flow99.in`).
2. WorkMail shows a TXT ownership challenge (a `_workmail-verification` record). Copy its exact host and value.
3. Add that TXT record at your DNS host. Wait for DNS propagation, then click **Verify** in WorkMail.
4. Do not move your domain's nameservers unless the host tells you to — only the DNS records listed in this guide need to change.

## Step 3 — Publish DNS records (MX, SPF, DKIM, DMARC)
Publish exactly the records WorkMail and your provider dashboards show. Do not invent values.

1. **MX:** add the MX records shown in Settings (these point inbound mail at the host's Cloudflare Email Routing).
2. **SPF:** keep exactly **one** SPF TXT record at the root hostname. Merge all authorized sender mechanisms into that one record. Multiple SPF records cause SPF permerror.
3. **DKIM:** add each provider's DKIM selector records exactly as displayed in that provider's dashboard. Never reuse sample selectors from a guide.
4. **DMARC:** add a TXT record at `_dmarc.<your-domain>`. Start with a monitoring policy, review aggregate reports, then tighten the policy after validating all legitimate senders.
5. Run WorkMail's DNS verification. Fix any Missing/Incorrect records before activation.

## Step 4 — Verify your sender in the provider dashboard
1. Open your outbound provider's official website and create an account yourself.
2. Complete any email, phone, business or sender verification that provider requires.
3. Add your sending domain in the provider dashboard.
4. Copy the exact SPF/DKIM records the provider shows and add them to your DNS (see Step 3).
5. Wait for the provider to verify the domain. WorkMail cannot verify the sender for you — the provider's own dashboard is the authority.

## Step 5 — Enter your provider keys in WorkMail
Repeat for each provider you choose (suggested order: SendPulse → Brevo → Mailjet → Resend):

1. In the provider dashboard, create an API key with the minimum permissions the provider supports.
2. In WorkMail, open **Settings → Sending providers**, choose the provider, paste the API key into the secure credential form and save. (Mailjet also needs its secret key.)
3. The key is encrypted server-side and shown masked after saving. It is never shown again — keep your own copy in a password manager.
4. Use **Test connection** and **Test send**. A successful API response means the provider accepted the message, not guaranteed inbox delivery.
5. Enable only providers whose account, sender domain and quota are verified.

## Step 6 — Create mailboxes and aliases
1. Open **Mailboxes → Create mailbox**.
2. Enter the local part, such as `hello`, `support` or `admin` (for example `hello@flow99.in`).
3. Set the display name and storage quota.
4. Create aliases that point to an existing mailbox if you need alternate addresses.
5. Choose a catch-all policy: deliver to a designated mailbox, quarantine, or reject unknown recipients. Reject/quarantine is safer against spam.
6. Assign mailbox access to your team members. A workspace membership alone does not grant access to a mailbox's messages — assign each person only the mailboxes they need.

## Step 7 — Send/receive test, then activate
1. Send an inbound test from an external mailbox (such as a personal Gmail account) to `hello@flow99.in`.
2. Verify sender, recipient, subject, body and attachments are stored correctly in the right mailbox.
3. Reply from WorkMail to an external address.
4. Check the provider attempt logs and delivery/bounce status in WorkMail.
5. Test a controlled provider failure (disable your first provider) and verify fallback does not create duplicate messages after an ambiguous timeout.
6. Activate the domain only when inbound, outbound, DNS and mailbox-access checks pass.

## Common problems
- **Domain remains Pending:** nameservers may not be active, or TXT/MX/DKIM values may be wrong. Re-check the exact host/name/value and wait for DNS propagation.
- **Inbound email missing:** check the MX records, then tell the host — the Email Routing / Worker path is host-owned.
- **Outbound rejected:** check the API key, sender-domain verification, quota, provider account status and suppression list in the provider dashboard.
- **SPF permerror:** remove duplicate SPF TXT records and consolidate approved mechanisms into one record.
- **Fallback duplicate:** do not immediately retry an ambiguous timeout; reconcile provider acceptance first (check the provider's own logs).

## Cost and quota reality
Free provider plans are suitable for a small pilot within their current quotas. They do not guarantee unlimited inbound/outbound mail, permanent free service, backups, SLA or commercial production capacity. Check each provider's live plan, sending policy and account eligibility before launch — see `FREE-PROVIDER-QUOTAS.md`. Budget for domain renewal and paid email volume as usage grows. The host's infrastructure (Vercel + Cloudflare D1/KV/Workers) is free-tier, no card — see `FREE-DEPLOY-GUIDE.md` for the limits.
