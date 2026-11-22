# WorkMail email templates (Phase 1)

No message goes out plain. Every send can use a branded, email-safe HTML
template that the workspace owner edits, previews, and test-sends.

## The honest note about "3D" (D2)

Real 3D, WebGL, and JavaScript do **not** run inside Gmail, Outlook, or
Apple Mail — email clients strip scripts and ignore WebGL entirely. Any
template that claimed live 3D rendering in the inbox would be a false
claim. What these templates do instead is the depth email clients
actually render: layered background colours (a dark brand header band
over a light page, a white card on top), borders, rounded corners, and
padding — all in plain table layout with inline CSS. That is the whole
technique, stated plainly.

## Designs

- **Layout:** nested `<table>`s, `width:100%; max-width:600px`, inline
  CSS only, system font stack (`Arial, Helvetica, sans-serif`). No
  external font dependency — a webfont `<link>` is stripped by most
  clients, so the design must look right on the stack alone.
- **Logo:** `public/email-logo.png` (PNG, 512×512, generated from the
  Flow99 mark). The BIMI SVG (`public/bimi-logo.svg`) is **not** used
  in email: SVG does not render in most email clients. The template
  `<img>` points at the absolute PNG URL
  (`https://workmail-delta.vercel.app/email-logo.png`, or
  `NEXT_PUBLIC_APP_URL` when set).
- **Header:** dark brand band with the logo and `{{sender_name}}`.
- **Footer (every template):** sender address line, an unsubscribe
  link (`{{unsubscribe_url}}`, a `mailto:` link), and "Sent via
  WorkMail".

## Categories and defaults

Categories: `auth` (verification/OTP), `welcome`, `notification`,
`newsletter` (bulk), `transactional` (generic/reply). One seeded
default per category per workspace is created on the first visit to
`/templates` — never at signup, so the signup path is untouched. A
category has at most one default (enforced by a partial unique index);
setting a new default unsets the old one, and deleting a default
promotes the oldest remaining template of that category.

## Variables

Available in every template: `{{name}}`, `{{otp}}`, `{{action_url}}`,
`{{sender_name}}`, `{{unsubscribe_url}}`, `{{email}}`. Bulk sends
additionally allow any recipient sheet column (for example
`{{company}}`).

- **Preview** (`/templates` live preview): unknown variables stay
  visible as `{{name}}` so the author can see what is missing.
- **Send time:** an unknown variable **rejects the send with a clear
  error** listing the variable. Values are never guessed, never
  rendered empty, never silently dropped. In bulk, a template that
  uses a variable no recipient can supply (for example `{{otp}}`) is
  rejected at campaign creation, not one failed recipient at a time.

## Sanitisation

Templates are sanitised on save (allowlist: table layout tags, `a`,
`p`, `h1`–`h3`, `img` with `https` src, inline styles only) and
re-sanitised at render. Stripped: `<script>`, `<style>`, event
handlers (`on*`), `javascript:`/`data:` URLs, external CSS, forms,
iframes, and SVG. Variable values are HTML-escaped before insertion
at render time, so a value can never inject markup.

Plain text is auto-derived from the HTML when no text version is
saved (links become `text (url)`), so providers always get both parts.

## Send path

- `lib/templates.ts` renders server-side only; the client never builds
  HTML. `executeSend` (in `lib/service-send.ts`) loads the template
  by id (workspace-scoped), renders subject + HTML + text, and sends
  the rendered content. The rendered subject/text/HTML are stored in
  the `outbound_jobs` payload so a retry re-sends the rendered mail.
- **List-Unsubscribe:** every bulk send and every template send sets
  the `List-Unsubscribe` header (`<mailto:sender?subject=Unsubscribe>`)
  via each provider's headers field (Brevo `headers`, Resend
  `headers`, Mailjet `Headers`, SendPulse `headers`) and carries the
  unsubscribe link in the footer. Plain single sends without a
  template carry neither.
- **From name (D3):** mailbox `display_name` → workspace name when it
  looks like a real brand → domain brand part (`flow99.in` →
  `Flow99`). The old literal fallback is removed; "WorkMail" is never
  used as a sender name.
- **Test-send** (`POST /api/templates/[id]/test`) sends the template
  to the signed-in user's own mailbox through the normal pipeline
  (provider Auto, same idempotency/suppression/caps), with sample
  values (`otp` 123456, `action_url` = the app URL).

## No-secret rule

Templates contain no secrets. Render never interpolates environment
values, tokens, or internal IDs — only the explicit context object
(`sender_name`, `unsubscribe_url`, caller-supplied variables, and
per-recipient columns in bulk).

## Files

- `db/migrations/0001_email_templates.sql` — `email_templates` table +
  `bulk_campaigns.template_id`
- `lib/templates.ts` — render, sanitise, plain-text, defaults, seeding
- `app/api/templates/route.ts`, `app/api/templates/[id]/route.ts`,
  `app/api/templates/[id]/test/route.ts`
- `app/templates/page.tsx` — list by category, editor + live preview,
  set default, test-send, two-step delete (inline confirm buttons only)
- `public/email-logo.png` — PNG logo for email (see above)
- Send-path edits: `lib/service-send.ts`, `app/api/send/route.ts`,
  `lib/bulk.ts`, `app/api/bulk/campaigns/route.ts`, compose picker in
  `app/page.tsx`, bulk picker in `app/bulk/page.tsx`,
  `List-Unsubscribe` header plumbing in `lib/providers.ts`
  (headers only — provider caps untouched).
