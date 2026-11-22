# Sender avatar — how recipients see your photo/logo in Gmail (S1, §15.1)

## The method that works (free)

There are two separate mechanisms, and they do different jobs. Do not mix them up.

### 1. Google alternate email + Google Account photo (the Gmail photo)

**What it does:** when a mailbox address (e.g. `hello@flow99.in`) is added as an
"alternate email" on the owner's Google Account, Gmail shows that account's
photo and name next to mails sent from the address.

**Steps (guided in-app in Settings → Sender profile, per mailbox):**

1. Open `myaccount.google.com` and sign in with the Google Account whose photo
   recipients should see.
2. Open **Personal info**.
3. Under "Contact info", open **Email**.
4. Open **Alternate emails**.
5. Click **Add alternate email** and enter the mailbox address exactly, then save.
6. Google sends a verification mail to that address — it lands in that
   mailbox's inbox in WorkMail.
7. Open the mail and click the verification link (or enter the code, if Google
   asks for a code instead).
8. If Google asks, approve the prompt on the signed-in phone.

**The same Google Account photo shows for every address linked to that
account** — one photo, all mailboxes on that account.

### 2. BIMI (the domain-level brand logo)

**What it does:** a DNS TXT record at `default._bimi.<domain>` points at a
hosted SVG logo. Mailbox providers that support BIMI show the brand logo next
to authenticated mail (DMARC at enforcement is required; flow99.in is at
`p=quarantine`).

**Current state:** the record exists — `default._bimi.flow99.in` →
`v=BIMI1; l=https://workmail-delta.vercel.app/bimi-logo.svg; a=;` — and the
logo is `public/bimi-logo.svg`. The in-app BIMI status (Settings → Sender
profile) is a **live server-side DNS read** on every check, and shows the raw
record. Full detail: `docs/BIMI.md`.

**Honest limit — Gmail needs a paid VMC.** Gmail displays a BIMI logo ONLY
with a Verified Mark Certificate (about $1,000/year) PLUS a registered
trademark. Without a VMC, Gmail shows NO logo even when the BIMI record is
valid. Apple Mail, Yahoo Mail and Fastmail can display the logo without a
VMC. Buying a VMC (and registering a trademark first) is a separate, paid
decision — it is NOT part of this work.

## What there is NO API for

**There is no Google API to add an alternate email to a personal Google
Account.** The alternate-email step is user-side by design: only the account
owner, signed in at `myaccount.google.com`, can add one. WorkMail therefore
builds a **guided in-app flow, not automation**:

- The wizard lists the exact clicks; the user does them in their Google Account.
- The checklist is **user-confirmed only** — a step is done when the user ticks
  it, and nothing is ever auto-checked, auto-verified, or inferred.
- The app cannot see the user's Google Account, cannot check whether an
  alternate email was added, and must never claim verification it cannot see.
- The BIMI status is the only live-verified part, and only because BIMI is
  public DNS the server can read.

Any future claim that WorkMail "verified" a Google alternate email would be
false unless Google ships an API for it.

## What recipients see — and what they don't

**They see:** the sender's Google Account photo and name next to the mail in
Gmail, and the mailbox address as the sender. (Where supported, the BIMI brand
logo instead of / alongside the photo, depending on the mail client.)

**They don't see:** the sender's phone number, other email addresses, other
mailboxes, or anything else from the Google Account. Linking an alternate email
does not share contacts or inbox contents with anyone. Google Contacts are
private to the account owner; WorkMail does not read Google Contacts at all.

## Implementation (where it lives)

| Piece | Location |
|---|---|
| Section UI (per mailbox, from the live mailbox list) | `app/settings/SenderProfileSection.tsx` (mounted in `app/settings/page.tsx`) |
| Mailbox photo (existing component, shown here) | `app/settings/ProfilePhotoSection.tsx` (KV-stored; avatar inside WorkMail only, does not travel in sent mail) |
| BIMI live check | `app/api/sender-profile/bimi/route.ts` — server-side DNS TXT read via dns.google DoH, same read pattern as `app/api/domains/dns/route.ts`; returns `verified` / `not_set_up` / `invalid` / `lookup_failed` + raw record + logo URL |
| User-confirmed checklist | `app/api/sender-profile/checklist/route.ts` — GET loads, POST ticks/unticks one step (membership-checked per mailbox) |
| Checklist storage | `db/migrations/0009_sender_profile.sql` — `sender_profile_steps (id, workspace_id, mailbox_id, step_key, done_at, created_at)`, unique per (workspace, mailbox, step) |

## Verification (parent checks V27–V30, plan §16)

- V27: read the wizard + explanation in Settings → Sender profile — steps exact
  and followable; states the same Google photo shows for every linked address;
  states what recipients see / don't see.
- V28: BIMI status → Re-check — shows the live status for flow99.in with the
  raw record shown.
- V29: tick 2 checklist steps, reload — ticks persist per mailbox; nothing else
  auto-checked; a new mailbox shows an empty checklist.
- V30: follow the wizard for one mailbox (user-side Google steps) — the
  verification mail lands in THAT mailbox's WorkMail inbox; after ticking all
  steps the section shows complete.
