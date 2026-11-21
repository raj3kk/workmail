# Free-tier provider comparison snapshot

Research snapshot: 20 November 2026. Allowances are subject to account eligibility, sender-domain verification, usage policies and provider changes.

| Provider | Publicly reported free allowance | Status |
|---|---:|---|
| SendPulse | Up to 12,000/month; daily/hourly caps also apply | Original PRD |
| Brevo | Up to 300/day | Original PRD |
| Mailjet | Up to 6,000/month; 200/day | Original PRD |
| Resend | Up to 3,000/month; 100/day | Original PRD |
| Mailtrap | Up to 4,000/month; daily cap also applies | Added adapter |
| SMTP2GO | Up to 1,000/month; 200/day | Added adapter |
| Google Apps Script/Gmail | Account-specific Gmail sending quotas | Original PRD backup |

No provider gives unlimited free outbound email to arbitrary recipients. Quotas are not additive guarantees; the router needs a persistent quota ledger before production. Never use failover to evade a provider's terms. HTTP 2xx means provider acceptance, not confirmed inbox delivery.

Attachment storage: Cloudflare KV is used. Cloudflare's card-gated object-storage service is NOT used — enabling it requires a card/PayPal on file, so it is out of this stack.
