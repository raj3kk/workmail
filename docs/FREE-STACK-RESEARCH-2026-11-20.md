# Free-stack research — 20 November 2026

## Recommended architecture
- Frontend: Cloudflare Pages/Workers static assets for a public/commercial SaaS on the free-first stack. Vercel Hobby is explicitly for personal, non-commercial use; do not build a commercial multi-user SaaS on Hobby. Use an eligible paid Vercel plan if Vercel hosting is mandatory.
- API and inbound processing: Cloudflare Workers.
- Database: Cloudflare D1 for relational metadata and message metadata.
- Attachments/raw MIME: Cloudflare KV with retention, quotas and scanning.
- AI: Cloudflare Workers AI for lightweight assist features; BYOK model provider support as an option.
- Inbound: Cloudflare Email Service Email Routing + Worker email handler.
- Outbound: user-owned provider accounts and per-tenant credentials, respecting each provider's acceptable-use policy.

## Official free-tier facts checked
- Cloudflare Email Routing can route inbound email to Workers and supports catch-all rules. It requires Cloudflare DNS. See https://developers.cloudflare.com/email-service/get-started/route-emails/ and https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
- Cloudflare Email Service inbound routing is available on Free and Paid Workers plans. Arbitrary-recipient outbound via Cloudflare Email Sending requires Workers Paid; free sending is only to verified destination addresses. See https://developers.cloudflare.com/email-service/
- Cloudflare Workers Free currently includes 100,000 requests/day and 10ms CPU per invocation. See https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 Free: 10 databases, 500 MB maximum per database, 5 GB total account storage; daily read/write limits apply. See https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare KV Free: 1 GB storage, 100,000 reads/day, 1,000 writes/day, 25 MB max value. See https://developers.cloudflare.com/kv/platform/limits/
- Cloudflare Workers AI free allocation: 10,000 Neurons/day; above that requires Workers Paid and is charged. See https://developers.cloudflare.com/workers-ai/platform/pricing/
- Vercel Hobby is intended for personal, non-commercial use. See https://vercel.com/docs/plans/hobby
- SendPulse free SMTP plan: 12,000 messages/month, 50 messages/hour, two authenticated domains; its broader email marketing page separately advertises up to 15,000/month. Treat SMTP and marketing quotas separately. See https://sendpulse.com/pricing/smtp and https://sendpulse.com/knowledge-base/smtp/limits
- Brevo Free: 300 sends/day. See https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
- Mailjet Free: 6,000/month, 200/day. See https://www.mailjet.com/pricing/
- Resend Free: 3,000/month, 100/day, up to 3 domains. See https://resend.com/pricing
- Mailtrap Free: 4,000/month, 150/day, 1 domain, 1 user. See https://mailtrap.io/pricing/

## Important corrections
- Do not describe inbound Email Routing as an unlimited IMAP mailbox service. It routes messages to a Worker; WorkMail must parse, store and expose them in its own webmail UI.
- Cloudflare Email Routing has address/rule constraints; a catch-all Worker can accept arbitrary local parts logically, then WorkMail decides which mailbox or catch-all target receives the message. This does not create unlimited provider quotas or unlimited storage.
- No legitimate free provider offers unlimited arbitrary outbound mail. The user's provider accounts have separate quotas and verification conditions.
- A domain registration/renewal is not free merely because hosting and routing use free tiers.

## 2026-11-21 update
The card-gated object-storage option evaluated on 2026-11-20 requires a card/PayPal on file to enable, so it is OUT of this stack. The chosen stack is D1 + KV + Workers + Vercel — all no-card, $0: Workers 100k requests/day, D1 5 GB total / 5M rows read/day / 100k rows written/day / 10 databases, KV 1 GB / 100k reads/day / 1,000 writes/day / 25 MB max value. Turso and Neon were evaluated as database alternatives (Turso free 5 GB / 500M reads per month, no card; Neon free 1 GB per project, no card) and D1 was chosen for single-vendor hosting fit with Workers and KV. Attachments live in KV. The deploy target is Vercel (one project, root directory `./`).
