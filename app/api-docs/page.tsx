import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Docs — WorkMail",
  description: "Integrate WorkMail with your website, platform, or AI agent: send mail and read messages over a scoped API key.",
};

// Public docs page — no login required to READ it. It contains NO real
// keys, NO secrets, NO internal IDs or URLs beyond the public app URL.
// Every example uses the placeholder WM_LIVE_KEY — replace it with a
// key you create in Settings → API keys.

const pageStyle: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 20px 64px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  lineHeight: 1.6,
  color: "#1a1a1a",
};

const h1: React.CSSProperties = { fontSize: 28, marginBottom: 4 };
const h2: React.CSSProperties = { fontSize: 20, marginTop: 32, marginBottom: 8 };
const h3: React.CSSProperties = { fontSize: 16, marginTop: 24, marginBottom: 8 };
const muted: React.CSSProperties = { color: "#666", marginTop: 0 };
const pre: React.CSSProperties = {
  background: "#111827",
  color: "#e5e7eb",
  padding: "14px 16px",
  borderRadius: 8,
  overflowX: "auto",
  fontSize: 13,
  lineHeight: 1.5,
};

const BASE_URL = "https://workmail-delta.vercel.app";

export default function ApiDocs() {
  return (
    <main style={pageStyle}>
      <h1 style={h1}>WorkMail API</h1>
      <p style={muted}>
        Integrate WorkMail with your website, platform, or AI agent by adding only the important
        things: send mail, and read messages. Base URL: <code>{BASE_URL}</code>
      </p>

      <h2 style={h2}>1. Create an API key</h2>
      <p>
        Sign in to WorkMail, open <b>Settings → API keys</b>, and create a key with a label and
        the scopes you need: <code>send</code> to send mail, <code>messages:read</code> to list
        messages. The key looks like <code>wm_live_…</code> and is shown <b>once</b> — copy it
        into your server&apos;s secrets (environment variable). It is never shown again, never
        appears in any API response, and can be revoked instantly from the same page.
      </p>
      <p>
        Keep the key on your server. Never put it in client-side JavaScript, a public repo, or
        a chat message — anyone holding it can send mail as your workspace (within its scope).
      </p>

      <h2 style={h2}>2. Authenticate</h2>
      <p>
        Send the key as a Bearer token on every request. Session cookies and any other token
        are not accepted by the v1 API.
      </p>
      <pre style={pre}>{`Authorization: Bearer WM_LIVE_KEY`}</pre>

      <h2 style={h2}>3. Send mail — POST /api/v1/send</h2>
      <p>
        Scope: <code>send</code>. The send runs through the same pipeline as the WorkMail inbox:
        monthly workspace cap, suppression list, idempotency, per-provider caps, and automatic
        fallback across your configured providers. The response is honest:{" "}
        <code>success: true</code> only when a provider accepted the message.
      </p>
      <pre style={pre}>{`curl -X POST ${BASE_URL}/api/v1/send \\
  -H "Authorization: Bearer WM_LIVE_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-12345" \\
  -d '{
    "to": "customer@example.com",
    "subject": "Your order is confirmed",
    "text": "Hi Ana, your order #12345 is confirmed. Thank you!",
    "html": "<p>Hi Ana, your order <b>#12345</b> is confirmed. Thank you!</p>"
  }'`}</pre>
      <p>Successful response:</p>
      <pre style={pre}>{`{
  "success": true,
  "provider": "brevo",
  "messageId": "provider-message-id",
  "sent_message_id": "workmail-message-id",
  "delivery_state": "accepted"
}`}</pre>
      <h3 style={h3}>Options</h3>
      <ul>
        <li>
          <code>provider</code> — <code>"auto"</code> (default, fallback chain) or one of{" "}
          <code>"sendpulse"</code>, <code>"brevo"</code>, <code>"mailjet"</code>,{" "}
          <code>"resend"</code> for a single-provider send.
        </li>
        <li>
          <code>mailbox_id</code> — which mailbox sends. Omit it to use the workspace&apos;s
          default mailbox.
        </li>
        <li>
          <code>thread_id</code> / <code>in_reply_to</code> — pass these when replying so the
          message joins the existing thread (see the AI-agent flow below).
        </li>
        <li>
          <code>Idempotency-Key</code> header (or <code>idempotency_key</code> in the body) —
          retrying with the same key and the same content returns the original result instead of
          sending twice. Reusing a key with different content is a 409.
        </li>
        <li>
          Limits: subject max 998 chars, text max 100,000 chars, HTML max 200,000 chars, up to
          10 attachments (10 MB total). Bodies over ~300 KB are rejected with 413. Per-key rate
          limit: 30 sends per minute (429 with a Retry-After header when exceeded).
        </li>
      </ul>

      <h2 style={h2}>4. List messages — GET /api/v1/messages</h2>
      <p>
        Scope: <code>messages:read</code>. Returns only your own workspace&apos;s messages —
        a key can never read another workspace.
      </p>
      <pre style={pre}>{`curl "${BASE_URL}/api/v1/messages?limit=20&delivery_state=received" \\
  -H "Authorization: Bearer WM_LIVE_KEY"`}</pre>
      <p>Response:</p>
      <pre style={pre}>{`{
  "messages": [
    {
      "id": "message-id",
      "mailbox_id": "mailbox-id",
      "folder": "inbox",
      "from": "customer@example.com",
      "to": "hello@example.com",
      "subject": "Do you deliver to Pune?",
      "delivery_state": "received",
      "provider": null,
      "received_at": "2026-11-22T08:00:00.000Z",
      "created_at": "2026-11-22T08:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "next_cursor": null
}`}</pre>
      <h3 style={h3}>Options</h3>
      <ul>
        <li>
          <code>mailbox_id</code> — filter to one mailbox (it must belong to your workspace).
        </li>
        <li>
          <code>limit</code> — 1–100, default 50. <code>cursor</code> — the opaque{" "}
          <code>next_cursor</code> from the previous page.
        </li>
        <li>
          <code>delivery_state</code> — e.g. <code>received</code>, <code>accepted</code>,{" "}
          <code>sent</code>, <code>delivered</code>, <code>bounced</code>, <code>failed</code>.
        </li>
        <li>
          <code>search</code> — matches subject, sender, and recipient.
        </li>
        <li>
          <code>include_body=true</code> — adds <code>text_body</code> and <code>html_body</code>{" "}
          to each row. Bodies are omitted by default.
        </li>
        <li>Per-key rate limit: 120 requests per minute (429 with Retry-After when exceeded).</li>
      </ul>

      <h2 style={h2}>5. AI-agent flow — read inbound, reply in-thread</h2>
      <p>
        Give your AI agent a key with <b>both</b> scopes. The agent polls for new inbound mail,
        drafts a reply from its own knowledge, and sends it in the same thread:
      </p>
      <pre style={pre}>{`# 1. Poll for new inbound mail (every minute or so)
curl "${BASE_URL}/api/v1/messages?delivery_state=received&limit=20&include_body=true" \\
  -H "Authorization: Bearer WM_LIVE_KEY"

# 2. Reply in-thread: thread_id from the inbound message, in_reply_to
#    is the inbound message's Message-ID (its "id" is the WorkMail row;
#    use the message_id from the provider headers when available).
curl -X POST ${BASE_URL}/api/v1/send \\
  -H "Authorization: Bearer WM_LIVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "customer@example.com",
    "subject": "Re: Do you deliver to Pune?",
    "text": "Hi, yes — we deliver to Pune in 2–3 days.",
    "thread_id": "thread-id-from-step-1",
    "in_reply_to": "inbound-message-id"
  }'

# 3. Poll again — the reply appears under delivery_state=accepted,
#    and any customer follow-up arrives as delivery_state=received.`}</pre>
      <p>
        Tip: give the agent its own labelled key (e.g. “Support agent”) so you can revoke just
        that key without touching your website integration.
      </p>

      <h2 style={h2}>6. Errors</h2>
      <ul>
        <li>
          <code>401</code> — missing, malformed, revoked, or expired key. (Session cookies and
          other tokens are never accepted here.)
        </li>
        <li>
          <code>403</code> — the key is valid but lacks the scope for this endpoint, or the
          mailbox in the request does not belong to the key&apos;s workspace.
        </li>
        <li>
          <code>400</code> — invalid body (see the error detail). <code>409</code> — recipient
          suppressed, monthly limit reached, domain not verified, or an idempotency key reused
          with different content.
        </li>
        <li>
          <code>413</code> — body or attachments over the size caps. <code>429</code> — per-key
          rate limit; wait for the Retry-After seconds.
        </li>
        <li>
          <code>202</code> — provider outcome unknown after a timeout. Do not resend blindly;
          check delivery state first.
        </li>
        <li>
          <code>502</code> — all configured providers rejected the send; nothing was delivered.
        </li>
      </ul>

      <h2 style={h2}>7. Security notes</h2>
      <ul>
        <li>Keys are stored as SHA-256 hashes only; the plaintext is shown once at creation.</li>
        <li>A key can only touch its own workspace — never another workspace&apos;s mail.</li>
        <li>Keys can expire (set an expiry at creation) and can be revoked instantly.</li>
        <li>
          The docs page and the API never expose internal identifiers, provider credentials, or
          host configuration.
        </li>
      </ul>

      <p style={muted}>
        <a href="/">← Back to WorkMail</a> · Full reference: docs/API.md in the repository.
      </p>
    </main>
  );
}
