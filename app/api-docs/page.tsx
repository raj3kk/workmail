import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Docs — WorkMail",
  description: "Integrate WorkMail with your website, platform, or AI agent: send mail, read messages, and find your mailboxes over a scoped API key.",
};

// Public docs page — no login required to READ it. It contains NO real
// keys, NO secrets, NO internal IDs or URLs beyond the public app URL.
// Every example uses the placeholder WM_LIVE_KEY — replace it with a
// key you create in Settings → API keys.
//
// Written for a non-technical reader: every endpoint lists its URL,
// method, headers, fields (with types and required/optional), and a
// copy-paste example in BOTH curl and JavaScript (fetch). Limits are
// stated honestly — nothing here is "unlimited".

const pageStyle: React.CSSProperties = {
  maxWidth: 780,
  margin: "0 auto",
  padding: "48px 20px 64px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  lineHeight: 1.6,
  color: "#1a1a1a",
};

const h1: React.CSSProperties = { fontSize: 28, marginBottom: 4 };
const h2: React.CSSProperties = { fontSize: 20, marginTop: 36, marginBottom: 8 };
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
const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
  marginTop: 8,
};
const th: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "2px solid #d1d5db",
  padding: "6px 8px",
  verticalAlign: "top",
};
const td: React.CSSProperties = {
  borderBottom: "1px solid #e5e7eb",
  padding: "6px 8px",
  verticalAlign: "top",
};

const BASE_URL = "https://workmail-delta.vercel.app";

export default function ApiDocs() {
  return (
    <main style={pageStyle}>
      <h1 style={h1}>WorkMail API</h1>
      <p style={muted}>
        Connect WorkMail to your website, platform, or AI agent by adding only the important
        things: send mail, read messages, and find your mailboxes. You do not need to know how
        email works underneath — copy an example below, replace <code>WM_LIVE_KEY</code> with
        your key, and it runs. Base URL: <code>{BASE_URL}</code>
      </p>

      <h2 style={h2}>1. Get your API key (step by step)</h2>
      <ol>
        <li>Sign in to WorkMail with Google.</li>
        <li>Open <b>Settings</b>, then the <b>API keys</b> section.</li>
        <li>
          Click <b>Create key</b>. Give it a label you will recognise (for example “My
          website” or “Support agent”), and tick the scopes you need: <code>send</code> to
          send mail, <code>messages:read</code> to list and read messages. You can also set
          an expiry date — the key stops working after it.
        </li>
        <li>
          The key appears <b>once</b>, looking like <code>wm_live_…</code>. Copy it now and
          paste it into your server&apos;s secrets (environment variable). It is never shown
          again, never appears in any API response, and you can revoke it instantly from the
          same page if it ever leaks.
        </li>
        <li>
          Use a separate labelled key per integration (one for your website, one for your AI
          agent). That way revoking one does not break the other.
        </li>
      </ol>
      <p>
        Keep the key on your server. Never put it in client-side JavaScript that runs in a
        visitor&apos;s browser, a public repo, or a chat message — anyone holding it can send
        mail as your workspace (within its scope).
      </p>

      <h2 style={h2}>2. Authenticate every request</h2>
      <p>
        Send the key as a Bearer token in the <code>Authorization</code> header on every
        request. Session cookies and any other token are not accepted by the v1 API — only the
        API key. A key can only touch its own workspace: it can never read or send another
        workspace&apos;s mail.
      </p>
      <pre style={pre}>{`Authorization: Bearer WM_LIVE_KEY
Content-Type: application/json   (only for requests with a body, i.e. POST)`}</pre>

      <h2 style={h2}>3. Find your mailboxes — GET /api/v1/mailboxes</h2>
      <p>
        Scope: <code>messages:read</code>. Before you can choose which mailbox sends a mail,
        you need its ID. This endpoint lists your workspace&apos;s active mailboxes — the
        address people see, and the ID to pass as <code>mailbox_id</code> elsewhere. The first
        mailbox in the list is your workspace default.
      </p>
      <p><b>curl:</b></p>
      <pre style={pre}>{`curl "${BASE_URL}/api/v1/mailboxes" \\
  -H "Authorization: Bearer WM_LIVE_KEY"`}</pre>
      <p><b>JavaScript (fetch):</b></p>
      <pre style={pre}>{`const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "${BASE_URL}";

const res = await fetch(BASE_URL + "/api/v1/mailboxes", {
  headers: { "Authorization": "Bearer " + API_KEY }
});
const data = await res.json();
console.log(res.status, data);`}</pre>
      <p>Successful response:</p>
      <pre style={pre}>{`{
  "mailboxes": [
    { "id": "mailbox-id-1", "address": "hello@example.com", "display_name": "Example Support" },
    { "id": "mailbox-id-2", "address": "support@example.com", "display_name": "" }
  ]
}`}</pre>
      <p>What each field means:</p>
      <ul>
        <li><code>id</code> — the mailbox ID. Pass it as <code>mailbox_id</code> when sending or listing messages.</li>
        <li><code>address</code> — the email address, for example <code>hello@example.com</code>. This is what recipients see in the From line.</li>
        <li><code>display_name</code> — the friendly sender name shown next to the address (empty when none is set).</li>
      </ul>

      <h2 style={h2}>4. Send an email — POST /api/v1/send</h2>
      <p>
        Scope: <code>send</code>. The send runs through the same pipeline as the WorkMail
        inbox: monthly workspace cap, suppression list, idempotency, per-provider caps, and
        automatic fallback across your configured providers. The response is honest:{" "}
        <code>success: true</code> only when a provider accepted the message.
      </p>
      <p><b>curl:</b></p>
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
      <p><b>JavaScript (fetch):</b></p>
      <pre style={pre}>{`const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "${BASE_URL}";

const res = await fetch(BASE_URL + "/api/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json",
    "Idempotency-Key": "order-12345"
  },
  body: JSON.stringify({
    to: "customer@example.com",
    subject: "Your order is confirmed",
    text: "Hi Ana, your order #12345 is confirmed. Thank you!",
    html: "<p>Hi Ana, your order <b>#12345</b> is confirmed. Thank you!</p>"
  })
});
const data = await res.json();
console.log(res.status, data);`}</pre>
      <p>Successful response:</p>
      <pre style={pre}>{`{
  "success": true,
  "provider": "brevo",
  "messageId": "provider-message-id",
  "sent_message_id": "workmail-message-id",
  "delivery_state": "accepted",
  "attempts": []
}`}</pre>
      <p>
        <code>provider</code> is which provider accepted the mail. <code>messageId</code> is
        the provider&apos;s ID for it; <code>sent_message_id</code> is WorkMail&apos;s own ID.
        <code>delivery_state</code> is <code>accepted</code> when a provider took the mail.
      </p>
      <h3 style={h3}>Body fields</h3>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Field</th>
            <th style={th}>Type</th>
            <th style={th}>Required?</th>
            <th style={th}>What it means</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td}><code>to</code></td>
            <td style={td}>string (email)</td>
            <td style={td}>Yes</td>
            <td style={td}>Who the mail goes to. One recipient per send.</td>
          </tr>
          <tr>
            <td style={td}><code>subject</code></td>
            <td style={td}>string, max 998 characters</td>
            <td style={td}>Yes</td>
            <td style={td}>The subject line.</td>
          </tr>
          <tr>
            <td style={td}><code>text</code></td>
            <td style={td}>string, max 100,000 characters</td>
            <td style={td}>One of <code>text</code> or <code>html</code></td>
            <td style={td}>The plain-text body. Give at least one of text / html.</td>
          </tr>
          <tr>
            <td style={td}><code>html</code></td>
            <td style={td}>string, max 200,000 characters</td>
            <td style={td}>One of <code>text</code> or <code>html</code></td>
            <td style={td}>The HTML body. Give at least one of text / html.</td>
          </tr>
          <tr>
            <td style={td}><code>provider</code></td>
            <td style={td}>string</td>
            <td style={td}>No — default <code>&quot;auto&quot;</code></td>
            <td style={td}><code>&quot;auto&quot;</code> tries your providers in order until one accepts. Or pick one: <code>&quot;sendpulse&quot;</code>, <code>&quot;brevo&quot;</code>, <code>&quot;mailjet&quot;</code>, <code>&quot;resend&quot;</code>. A manual pick only works if that provider is enabled and sender-verified for your workspace.</td>
          </tr>
          <tr>
            <td style={td}><code>mailbox_id</code></td>
            <td style={td}>string (UUID)</td>
            <td style={td}>No</td>
            <td style={td}>Which mailbox the mail comes FROM. Get IDs from §3. Omit it to use your workspace default mailbox.</td>
          </tr>
          <tr>
            <td style={td}><code>thread_id</code></td>
            <td style={td}>string (UUID)</td>
            <td style={td}>No</td>
            <td style={td}>Replying: the thread to join (from a message listed in §5). Omit for a new mail.</td>
          </tr>
          <tr>
            <td style={td}><code>in_reply_to</code></td>
            <td style={td}>string, max 998 characters</td>
            <td style={td}>No</td>
            <td style={td}>Replying: the Message-ID of the mail being answered. Omit for a new mail.</td>
          </tr>
          <tr>
            <td style={td}><code>idempotency_key</code></td>
            <td style={td}>string, max 200 characters</td>
            <td style={td}>No</td>
            <td style={td}>Your own unique ID for this send (for example your order number). Retrying with the same key and the same content returns the original result instead of sending twice. Same key + different content is a 409. You can also send it as the <code>Idempotency-Key</code> header instead.</td>
          </tr>
          <tr>
            <td style={td}><code>attachments</code></td>
            <td style={td}>array (see below)</td>
            <td style={td}>No</td>
            <td style={td}>Files to attach, as base64 (below). Max 10 files, total 1 MB, each file 2 MB.</td>
          </tr>
          <tr>
            <td style={td}><code>template_id</code></td>
            <td style={td}>string (UUID)</td>
            <td style={td}>No</td>
            <td style={td}>Send using a saved email template instead of writing the body yourself. The template supplies the subject and body (your <code>text</code>/<code>html</code> are ignored when it is set). Find template IDs on the Templates page in WorkMail.</td>
          </tr>
          <tr>
            <td style={td}><code>variables</code></td>
            <td style={td}>object (string → string, each value max 2,000 characters)</td>
            <td style={td}>No — only with <code>template_id</code></td>
            <td style={td}>Values for the template&apos;s placeholders, for example <code>{`{"name": "Ana", "otp": "123456"}`}</code>. An unknown placeholder name is a 400 and nothing is sent.</td>
          </tr>
        </tbody>
      </table>

      <h3 style={h3}>Attachments — send a file with the mail</h3>
      <p>
        Add an <code>attachments</code> array. Each file is sent as base64 text — the file
        content encoded as text, so it can travel inside JSON. Allowed file types: PDF, PNG,
        JPEG, GIF, WebP, plain text (.txt), CSV, ZIP, Word (.docx), Excel (.xlsx). Limits:
        each file max 2 MB, all files together max 1 MB, max 10 files. Over the limits the
        API answers 413 and nothing is sent.
      </p>
      <p><b>curl</b> (turn a file into base64 first — on Linux: <code>base64 -w0 invoice.pdf</code>; on macOS: <code>base64 -i invoice.pdf</code>):</p>
      <pre style={pre}>{`B64=$(base64 -w0 invoice.pdf)   # Linux; macOS: base64 -i invoice.pdf
curl -X POST ${BASE_URL}/api/v1/send \\
  -H "Authorization: Bearer WM_LIVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "customer@example.com",
    "subject": "Your invoice",
    "text": "Please find your invoice attached.",
    "attachments": [
      {
        "filename": "invoice.pdf",
        "content_type": "application/pdf",
        "content_base64": "'"$B64"'"
      }
    ]
  }'`}</pre>
      <p><b>JavaScript (fetch, Node.js):</b></p>
      <pre style={pre}>{`const fs = require("fs");
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "${BASE_URL}";

const pdfBase64 = fs.readFileSync("invoice.pdf").toString("base64");

const res = await fetch(BASE_URL + "/api/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    to: "customer@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    attachments: [
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        content_base64: pdfBase64
      }
    ]
  })
});
const data = await res.json();
console.log(res.status, data);`}</pre>
      <p>
        Each attachment needs all three fields: <code>filename</code> (the name the recipient
        sees), <code>content_type</code> (the file type, for example{" "}
        <code>application/pdf</code> for a PDF), and <code>content_base64</code> (the file
        content encoded as base64 text). A missing filename, a type that is not allowed, or
        text that is not valid base64 is a 400 — nothing is sent.
      </p>

      <h2 style={h2}>5. List messages — GET /api/v1/messages</h2>
      <p>
        Scope: <code>messages:read</code>. Returns only your own workspace&apos;s messages,
        newest first — a key can never read another workspace. Message bodies (the actual
        text) are left out by default; ask for them only when you need them.
      </p>
      <p><b>curl:</b></p>
      <pre style={pre}>{`curl "${BASE_URL}/api/v1/messages?limit=20&delivery_state=received" \\
  -H "Authorization: Bearer WM_LIVE_KEY"`}</pre>
      <p><b>JavaScript (fetch):</b></p>
      <pre style={pre}>{`const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "${BASE_URL}";

const res = await fetch(
  BASE_URL + "/api/v1/messages?limit=20&delivery_state=received",
  { headers: { "Authorization": "Bearer " + API_KEY } }
);
const data = await res.json();
console.log(res.status, data);
// data.messages is the list; data.next_cursor pages forward (see below).`}</pre>
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
      "thread_id": "thread-id",
      "message_id": "inbound-message-id",
      "received_at": "2026-11-22T08:00:00.000Z",
      "created_at": "2026-11-22T08:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "next_cursor": null
}`}</pre>
      <p>What each field means:</p>
      <ul>
        <li><code>id</code> — WorkMail&apos;s ID for the message.</li>
        <li><code>mailbox_id</code> — which mailbox it belongs to (see §3 for the list).</li>
        <li><code>folder</code> — <code>inbox</code>, <code>sent</code>, <code>drafts</code>, and so on.</li>
        <li><code>from</code> / <code>to</code> — sender and recipient addresses.</li>
        <li><code>delivery_state</code> — where the mail is: <code>received</code> (came in), <code>accepted</code> (a provider took it), <code>sent</code>, <code>delivered</code>, <code>opened</code>, <code>clicked</code>, <code>deferred</code>, <code>bounced</code>, <code>complained</code>, <code>failed</code>, <code>unknown</code>.</li>
        <li><code>provider</code> — which provider handled it (<code>null</code> for inbound mail).</li>
        <li><code>thread_id</code> — the conversation thread this message belongs to (<code>null</code> when none). Pass it back when replying (§7).</li>
        <li><code>message_id</code> — the Message-ID of this mail (<code>null</code> when none recorded). Pass it back as <code>in_reply_to</code> when replying (§7).</li>
        <li><code>received_at</code> / <code>created_at</code> — when it arrived / was recorded.</li>
        <li><code>total</code> — how many messages match your filters in total. <code>next_cursor</code> — pass it as <code>?cursor=…</code> to fetch the next page; <code>null</code> means you are on the last page.</li>
      </ul>
      <h3 style={h3}>Query parameters</h3>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Parameter</th>
            <th style={th}>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td}><code>mailbox_id</code></td>
            <td style={td}>Show only one mailbox (it must belong to your workspace — another workspace&apos;s ID is a 403). Omit it to see all your mailboxes together.</td>
          </tr>
          <tr>
            <td style={td}><code>limit</code></td>
            <td style={td}>How many messages per page: 1–100, default 50.</td>
          </tr>
          <tr>
            <td style={td}><code>cursor</code></td>
            <td style={td}>The opaque <code>next_cursor</code> from the previous page. Pass it to get the next page.</td>
          </tr>
          <tr>
            <td style={td}><code>delivery_state</code></td>
            <td style={td}>Show only one state, for example <code>received</code> (new inbound mail) or <code>bounced</code>.</td>
          </tr>
          <tr>
            <td style={td}><code>search</code></td>
            <td style={td}>Search text — matches the subject, sender, and recipient.</td>
          </tr>
          <tr>
            <td style={td}><code>include_body=true</code></td>
            <td style={td}>Adds <code>text_body</code> and <code>html_body</code> (the actual message text) to each row. Off by default — leave it off unless you need the body.</td>
          </tr>
        </tbody>
      </table>

      <h2 style={h2}>6. Which mailbox sends? (mailbox choice)</h2>
      <ul>
        <li>
          <b>Sending:</b> pass <code>mailbox_id</code> in the send body to choose which
          mailbox the mail comes FROM. Omit it and the workspace default mailbox sends (the
          first one listed by §3).
        </li>
        <li>
          <b>Listing:</b> pass <code>mailbox_id</code> in the query to filter to one mailbox,
          or omit it to see all mailboxes together.
        </li>
        <li>
          <b>Finding IDs:</b> call <code>GET /api/v1/mailboxes</code> (§3) — it returns every
          mailbox with its ID and address. Never guess an ID, and never copy one from another
          workspace: a <code>mailbox_id</code> that is not yours is a 403.
        </li>
      </ul>

      <h2 style={h2}>7. AI-agent flow — read inbound, reply in-thread</h2>
      <p>
        Your own AI agent uses the same two endpoints with the same key. Give it a key with{" "}
        <b>both</b> scopes (<code>send</code> + <code>messages:read</code>). The agent polls
        for new inbound mail, drafts a reply from its own knowledge, and sends it in the same
        thread so the customer sees one conversation:
      </p>
      <p><b>curl:</b></p>
      <pre style={pre}>{`# 1. Poll for new inbound mail (every minute or so)
curl "${BASE_URL}/api/v1/messages?delivery_state=received&limit=20&include_body=true" \\
  -H "Authorization: Bearer WM_LIVE_KEY"

# 2. Reply in-thread: thread_id and message_id come from the
#    listed message in step 1 (§5). Pass thread_id as thread_id and
#    message_id as in_reply_to, so the reply joins the same thread.
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
      <p><b>JavaScript (fetch) — the same flow:</b></p>
      <pre style={pre}>{`const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "${BASE_URL}";

async function workmail(path, options) {
  const res = await fetch(BASE_URL + path, {
    ...(options || {}),
    headers: {
      "Authorization": "Bearer " + API_KEY,
      ...((options && options.headers) || {})
    }
  });
  return { status: res.status, data: await res.json() };
}

// 1. Poll for new inbound mail
const inbox = await workmail("/api/v1/messages?delivery_state=received&limit=20&include_body=true");
const inbound = inbox.data.messages[0];
if (inbound) {
  // 2. Reply in-thread
  const reply = await workmail("/api/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: inbound.from,
      subject: "Re: " + inbound.subject,
      text: "Hi, yes — we deliver to Pune in 2–3 days.",
      thread_id: inbound.thread_id,
      in_reply_to: inbound.message_id
    })
  });
  console.log(reply.status, reply.data);
}`}</pre>
      <p>
        Tip: give the agent its own labelled key (for example “Support agent”) so you can
        revoke just that key without touching your website integration.
      </p>

      <h2 style={h2}>8. If something goes wrong — error responses</h2>
      <p>
        Every error is a JSON body like <code>{`{ "error": "…reason…" }`}</code> with an HTTP
        status. What each status means, in plain words, and what to do:
      </p>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Status</th>
            <th style={th}>What it means</th>
            <th style={th}>What to do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td}><code>400</code></td>
            <td style={td}>Something in your request is wrong — a missing or invalid field (bad email address, empty subject, bad base64, disallowed attachment type, unknown <code>delivery_state</code>, or an unknown template variable). The response names the problem.</td>
            <td style={td}>Fix the field the error names and try again. Nothing was sent.</td>
          </tr>
          <tr>
            <td style={td}><code>401</code></td>
            <td style={td}>Your key is missing, malformed, revoked, or expired. (Session cookies and other tokens are never accepted here.)</td>
            <td style={td}>Check the <code>Authorization: Bearer …</code> header. Create a new key in Settings → API keys if yours was revoked or expired.</td>
          </tr>
          <tr>
            <td style={td}><code>403</code></td>
            <td style={td}>The key is valid, but it does not have the scope this endpoint needs — or the <code>mailbox_id</code> in your request belongs to another workspace (or does not exist).</td>
            <td style={td}>Create a key with the right scope, or get the mailbox ID from §3. Do not guess IDs.</td>
          </tr>
          <tr>
            <td style={td}><code>404</code></td>
            <td style={td}>Something you referenced was not found — for example an attachment ID that does not belong to your workspace, or a wrong URL.</td>
            <td style={td}>Check the ID / URL. A foreign ID and a nonexistent ID give the same 404 on purpose, so you cannot probe for other workspaces&apos; data.</td>
          </tr>
          <tr>
            <td style={td}><code>409</code></td>
            <td style={td}>The request conflicts with the current state: the recipient is on your suppression list, the monthly sending limit is reached, the domain is not verified, or an idempotency key was reused with different content.</td>
            <td style={td}>Read the error text: remove the recipient from suppression (or pick another), wait for next month, verify the domain, or use a fresh idempotency key. Retrying the same request will not help.</td>
          </tr>
          <tr>
            <td style={td}><code>413</code></td>
            <td style={td}>Too big — the request body is over 2 MB, or the attachments are over the caps (1 MB total, 2 MB per file).</td>
            <td style={td}>Shrink the mail: smaller attachments, or fewer of them. Nothing was sent.</td>
          </tr>
          <tr>
            <td style={td}><code>429</code></td>
            <td style={td}>Rate limit — you sent too many requests too fast. The response carries a <code>Retry-After</code> header with the seconds to wait.</td>
            <td style={td}>Wait the <code>Retry-After</code> seconds, then retry. Do not hammer the API — see §9 for the limits.</td>
          </tr>
          <tr>
            <td style={td}><code>202</code></td>
            <td style={td}>Not an error, but not a success either: the provider timed out, so WorkMail does not know whether the mail went out.</td>
            <td style={td}>Do NOT resend blindly — check <code>GET /api/v1/messages</code> for the delivery state first, or the mail may go out twice.</td>
          </tr>
          <tr>
            <td style={td}><code>502</code></td>
            <td style={td}>All configured providers rejected the send (or an attachment could not be stored/read). Nothing was delivered.</td>
            <td style={td}>Check your provider setup in Settings (enabled, sender verified). You may retry later with a new idempotency key — no duplicate can result, because nothing was accepted.</td>
          </tr>
        </tbody>
      </table>

      <h2 style={h2}>9. Limits — stated honestly</h2>
      <p>Nothing here is unlimited. The caps that apply to API use:</p>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Limit</th>
            <th style={th}>Value</th>
            <th style={th}>What happens at the cap</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td}>Send rate (per API key)</td>
            <td style={td}>30 sends per minute</td>
            <td style={td}>429 with <code>Retry-After</code> — wait and retry.</td>
          </tr>
          <tr>
            <td style={td}>List / mailbox rate (per API key)</td>
            <td style={td}>120 requests per minute</td>
            <td style={td}>429 with <code>Retry-After</code> — wait and retry.</td>
          </tr>
          <tr>
            <td style={td}>Monthly sends (per workspace)</td>
            <td style={td}>300 sends per month</td>
            <td style={td}>Further sends are rejected with 409 until the next month.</td>
          </tr>
          <tr>
            <td style={td}>SendPulse (free plan)</td>
            <td style={td}>50 per hour, 400 per day, 1 MB max message size</td>
            <td style={td}>Auto mode falls through to the next provider; a manual SendPulse pick is rejected once capped.</td>
          </tr>
          <tr>
            <td style={td}>Brevo (free plan)</td>
            <td style={td}>300 per day</td>
            <td style={td}>Same fallback behaviour as above.</td>
          </tr>
          <tr>
            <td style={td}>Mailjet (free plan)</td>
            <td style={td}>200 per day</td>
            <td style={td}>Same fallback behaviour as above.</td>
          </tr>
          <tr>
            <td style={td}>Resend (free plan)</td>
            <td style={td}>100 per day</td>
            <td style={td}>Same fallback behaviour as above.</td>
          </tr>
          <tr>
            <td style={td}>Attachments via the API</td>
            <td style={td}>1 MB total per mail, 2 MB per file, max 10 files</td>
            <td style={td}>413 — nothing is sent.</td>
          </tr>
          <tr>
            <td style={td}>Request body</td>
            <td style={td}>2 MB</td>
            <td style={td}>413 — nothing is sent.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Polling tip for AI agents: checking for new mail once a minute stays far below the
        120/minute list limit. Do not poll every second — it wastes your allowance and gains
        nothing.
      </p>

      <h2 style={h2}>10. Security notes</h2>
      <ul>
        <li>Keys are stored as SHA-256 hashes only; the plaintext is shown once at creation.</li>
        <li>A key can only touch its own workspace — never another workspace&apos;s mail.</li>
        <li>Keys can expire (set an expiry at creation) and can be revoked instantly.</li>
        <li>
          The docs page and the API never expose internal identifiers, provider credentials, or
          host configuration.
        </li>
        <li>
          Attachment bytes are stored in the same store as inbox attachments and are only ever
          sent to the provider you chose, for the mail you asked for.
        </li>
      </ul>

      <p style={muted}>
        <a href="/">← Back to WorkMail</a> · Full reference: docs/API.md in the repository.
      </p>
    </main>
  );
}
