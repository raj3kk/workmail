"use client";
import {useCallback, useEffect, useRef, useState} from "react";

// Settings → Delivery webhook tokens (Phase 3a, G-01 / decision D6).
// A token lets a delivery-event sender POST bounces/deliveries to
// /api/delivery/webhook for THIS workspace only. The full token is
// shown ONCE, right after creation, with a copy button — it is never
// stored in plaintext and no GET ever returns it again. Revoke uses
// an inline two-step confirm (click once to arm, click again to
// revoke) — never window.confirm().
//
// MOUNT NOTE (coordinator): app/settings/page.tsx is coordinator-owned.
// Mount with one import + one JSX line, next to ApiKeysSection:
//   import WebhookTokensSection from "./WebhookTokensSection";
//   <WebhookTokensSection workspace={workspace}/>

const CONFIRM_ARM_MS = 5000;

type WebhookTokenRow = {
  id: string;
  label: string;
  token_prefix: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function formatDate(v: string | null): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}

export default function WebhookTokensSection({workspace}: {workspace: string}) {
  const [tokens, setTokens] = useState<WebhookTokenRow[]>([]);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState("");
  const [confirmRevokeId, setConfirmRevokeId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTokens = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/webhook-tokens?workspace_id=" + encodeURIComponent(workspace));
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not load webhook tokens.");
        return;
      }
      setTokens(d.tokens || []);
    } catch {
      setError("Could not load webhook tokens.");
    }
  }, [workspace]);

  useEffect(() => {
    loadTokens();
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, [loadTokens]);

  function disarmRevoke() {
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setConfirmRevokeId("");
  }

  function armRevoke(id: string) {
    setError("");
    setNotice("");
    setConfirmRevokeId(id);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => setConfirmRevokeId(""), CONFIRM_ARM_MS);
  }

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    if (!label.trim()) {
      setError("Give the token a label, e.g. “Brevo delivery events”.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    setNewToken(null);
    setCopied(false);
    try {
      const r = await fetch("/api/webhook-tokens", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          workspace_id: workspace,
          label: label.trim(),
          expires_at: expiry ? new Date(expiry).toISOString() : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not create webhook token.");
        return;
      }
      setNewToken(d.webhook_token);
      setNotice("Token created — copy it now. It will never be shown again.");
      setLabel("");
      setExpiry("");
      loadTokens();
    } catch {
      setError("Could not create webhook token.");
    } finally {
      setCreating(false);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setError("Copy failed — select the token text and copy it manually.");
    }
  }

  async function revokeToken(id: string) {
    disarmRevoke();
    setRevoking(id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/webhook-tokens?id=" + encodeURIComponent(id), {method: "DELETE"});
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not revoke webhook token.");
        return;
      }
      setNotice("Webhook token revoked — it stops working immediately.");
      loadTokens();
    } catch {
      setError("Could not revoke webhook token.");
    } finally {
      setRevoking("");
    }
  }

  if (!workspace)
    return (
      <section>
        <h2>Delivery webhook tokens</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>Delivery webhook tokens</h2>
      <p>
        Tokens let a delivery-event sender report bounces, deliveries, and complaints to{" "}
        <code>/api/delivery/webhook</code> for this workspace only. The endpoint derives the
        workspace from the token and rejects any other workspace in the request — a token from
        one workspace can never write events for another.
      </p>
      <p className="muted">
        Treat a token like a password: it is shown once, right after creation. Send it as{" "}
        <code>Authorization: Bearer …</code> from your server. Never paste it into chat, commit
        it to GitHub, or ship it in client-side code.
      </p>
      {newToken && (
        <article>
          <b>Your new webhook token — copy it now, it will never be shown again</b>
          <p>
            <code style={{wordBreak: "break-all"}}>{newToken}</code>
          </p>
          <button type="button" onClick={copyToken}>
            {copied ? "Copied ✓" : "Copy token"}
          </button>
          <p className="muted">
            Store it in your server&apos;s secrets (environment variable), not in your code.
          </p>
        </article>
      )}
      <form onSubmit={createToken}>
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Brevo delivery events)"
          maxLength={100}
        />
        <label>
          Expires (optional){" "}
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <button className="primary" disabled={creating}>
          {creating ? "Creating…" : "Create webhook token"}
        </button>
      </form>
      {tokens.length === 0 ? (
        <p className="muted">No webhook tokens yet for this workspace.</p>
      ) : (
        tokens.map((t) => (
          <article key={t.id}>
            <b>{t.label}</b>
            <span>
              {t.token_prefix}… ·{" "}
              {t.revoked_at ? "revoked " + formatDate(t.revoked_at) : "active"}
            </span>
            <span>
              Created {formatDate(t.created_at)} · Last used {formatDate(t.last_used_at)}
              {t.expires_at ? " · Expires " + formatDate(t.expires_at) : ""}
            </span>
            {!t.revoked_at &&
              (confirmRevokeId === t.id ? (
                <>
                  <button
                    type="button"
                    disabled={revoking === t.id}
                    onClick={() => revokeToken(t.id)}
                    style={{background: "#5b2333", borderColor: "#8a3a44"}}
                  >
                    {revoking === t.id ? "Revoking…" : "Click again to confirm revoke"}
                  </button>
                  <button type="button" disabled={revoking === t.id} onClick={disarmRevoke}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => armRevoke(t.id)}>
                  Revoke
                </button>
              ))}
          </article>
        ))
      )}
      {error && <p style={{fontSize: 12, color: "#f2a6a6", margin: "8px 0 0"}}>{error}</p>}
      {notice && <p style={{fontSize: 12, color: "#8fd9b9", margin: "8px 0 0"}}>{notice}</p>}
    </section>
  );
}
