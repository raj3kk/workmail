import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — WorkMail",
  description: "How WorkMail collects, uses, and protects your information.",
};

const pageStyle: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "48px 20px 64px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  lineHeight: 1.6,
  color: "#1a1a1a",
};

const h1: React.CSSProperties = { fontSize: 28, marginBottom: 4 };
const h2: React.CSSProperties = { fontSize: 20, marginTop: 32, marginBottom: 8 };
const muted: React.CSSProperties = { color: "#666", marginTop: 0 };

export default function PrivacyPolicy() {
  return (
    <main style={pageStyle}>
      <h1 style={h1}>Privacy Policy — WorkMail</h1>
      <p style={muted}>Effective date: 21 November 2026. Last updated: 21 November 2026.</p>

      <p>
        WorkMail is a business email workspace for custom domains. It is operated by
        P. R. Digital Enterprises, India. Contact: flipify.com@gmail.com.
        This policy explains what information WorkMail collects, how it is used,
        and the choices you have. WorkMail is intended for users aged 18 and over.
      </p>

      <h2 style={h2}>1. Information we collect</h2>
      <ul>
        <li>
          <b>Account information:</b> when you sign in with Google, we receive your
          Google account identifier, email address, and display name. Google sign-in
          is used only to identify you in WorkMail; it does not grant WorkMail access
          to your Gmail inbox.
        </li>
        <li>
          <b>Workspace and mailbox data:</b> workspace names, mailbox addresses,
          domains and DNS settings, contacts, labels, mail rules, and drafts that you
          or your workspace administrator enter.
        </li>
        <li>
          <b>Message data:</b> emails you send and receive through your WorkMail
          mailboxes, including senders, recipients, subjects, message bodies, and
          attachments.
        </li>
        <li>
          <b>Service and usage data:</b> delivery events (sent, delivered, bounced,
          complained), suppression entries, send counts used to enforce plan limits,
          and security/audit events such as sign-ins and administrative actions.
        </li>
        <li>
          <b>Provider credentials:</b> API keys for the outbound mail providers a
          workspace administrator configures. These are encrypted at rest and are
          never shown in plain text in the app, logs, or API responses.
        </li>
      </ul>

      <h2 style={h2}>2. How we use information</h2>
      <ul>
        <li>To provide the email service: receive, store, display, and send mail for your mailboxes.</li>
        <li>To authenticate you and enforce workspace, role, and mailbox permissions.</li>
        <li>To route outbound mail through the providers your workspace configured, with automatic failover.</li>
        <li>To enforce plan limits, suppress bounces and complaints, and keep the service secure and reliable.</li>
        <li>To respond to support requests sent to the contact address above.</li>
      </ul>

      <h2 style={h2}>3. Sharing and processors</h2>
      <p>
        We do not sell your personal information, and we do not use it for advertising.
        Your data is processed by the following service providers, only as needed to
        run WorkMail:
      </p>
      <ul>
        <li><b>Google</b> — sign-in (OAuth) identity verification.</li>
        <li><b>Vercel</b> — application hosting.</li>
        <li><b>Cloudflare</b> — database (D1), file storage (KV), and inbound email handling (Workers).</li>
        <li><b>Outbound mail providers</b> chosen by your workspace administrator (for example SendPulse, Brevo, Mailjet, or Resend) — delivery of mail you send.</li>
      </ul>
      <p>
        We may disclose information if required by law or to protect the security of
        the service.
      </p>

      <h2 style={h2}>4. Security</h2>
      <p>
        Provider credentials are encrypted at rest (AES-256-GCM). Sign-in sessions use
        opaque, hashed session cookies. Optional multi-factor authentication (TOTP) is
        available. Access to mailboxes is isolated per workspace, and administrative
        actions are logged. No security measure is perfect, and we cannot guarantee
        absolute security.
      </p>

      <h2 style={h2}>5. Retention and deletion</h2>
      <p>
        Messages and workspace data are kept until you or your workspace administrator
        deletes them. Deleted messages move to Trash; workspace administrators can
        permanently remove data. Backups, where enabled, are encrypted and retained
        for a limited period before being deleted.
      </p>

      <h2 style={h2}>6. Your rights and choices</h2>
      <p>
        You can review and update your workspace data in Settings. To request a copy
        of your data, correction, or deletion of your account and its data, contact
        flipify.com@gmail.com. We will respond within a reasonable time. Deleting your
        account removes your access; mailbox data belonging to a workspace may be
        retained by that workspace administrator as described above.
      </p>

      <h2 style={h2}>7. Changes to this policy</h2>
      <p>
        If this policy changes, we will update the effective date above. Continued use
        of WorkMail after a change means you accept the updated policy.
      </p>

      <h2 style={h2}>8. Contact</h2>
      <p>
        Questions about this policy: flipify.com@gmail.com (operator: P. R. Digital
        Enterprises, India).
      </p>

      <p style={muted}>
        <a href="/">← Back to WorkMail</a>
      </p>
    </main>
  );
}
