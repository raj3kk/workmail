"use client";
import {useCallback, useEffect, useRef, useState} from "react";

// Settings → API keys (Phase 2, decision D4).
// Create a per-workspace, scoped, revocable key for the v1 integration
// API (POST /api/v1/send, GET /api/v1/messages). The full key is shown
// ONCE, right after creation, with a copy button — it is never stored
// in plaintext and no GET ever returns it again. Revoke uses an inline
// two-step confirm (click once to arm, click again to revoke) — never
// window.confirm().

const CONFIRM_ARM_MS = 5000;

type ApiKeyRow = {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
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

export default function ApiKeysSection({workspace}: {workspace: string}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [label, setLabel] = useState("");
  const [scopeSend, setScopeSend] = useState(true);
  const [scopeRead, setScopeRead] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState("");
  const [confirmRevokeId, setConfirmRevokeId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadKeys = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/api-keys?workspace_id=" + encodeURIComponent(workspace));
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not load API keys.");
        return;
      }
      setKeys(d.keys || []);
    } catch {
      setError("Could not load API keys.");
    }
  }, [workspace]);

  useEffect(() => {
    loadKeys();
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, [loadKeys]);

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

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    const scopes: string[] = [];
    if (scopeSend) scopes.push("send");
    if (scopeRead) scopes.push("messages:read");
    if (!label.trim()) {
      setError("Give the key a label, e.g. “Website contact form”.");
      return;
    }
    if (scopes.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    setNewKey(null);
    setCopied(false);
    try {
      const r = await fetch("/api/api-keys", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          workspace_id: workspace,
          label: label.trim(),
          scopes,
          expires_at: expiry ? new Date(expiry).toISOString() : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not create API key.");
        return;
      }
      setNewKey(d.api_key);
      setNotice("Key created — copy it now. It will never be shown again.");
      setLabel("");
      setExpiry("");
      loadKeys();
    } catch {
      setError("Could not create API key.");
    } finally {
      setCreating(false);
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setError("Copy failed — select the key text and copy it manually.");
    }
  }

  async function revokeKey(id: string) {
    disarmRevoke();
    setRevoking(id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/api-keys/" + encodeURIComponent(id), {method: "DELETE"});
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not revoke API key.");
        return;
      }
      setNotice("API key revoked — it stops working immediately.");
      loadKeys();
    } catch {
      setError("Could not revoke API key.");
    } finally {
      setRevoking("");
    }
  }

  if (!workspace)
    return (
      <section>
        <h2>API keys</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>API keys</h2>
      <p>
        Keys let your website, platform, or AI agent send mail and read messages through the
        WorkMail API (<code>/api/v1/send</code>, <code>/api/v1/messages</code>). Each key belongs
        to this workspace only, has the scopes you pick, and can be revoked instantly. See the{" "}
        <a href="/api-docs">API docs</a> for copy-paste examples.
      </p>
      <p className="muted">
        Treat a key like a password: it is shown once, right after creation. Never paste it into
        chat, commit it to GitHub, or ship it in client-side code — call the API from your server.
      </p>
      {newKey && (
        <article>
          <b>Your new API key — copy it now, it will never be shown again</b>
          <p>
            <code style={{wordBreak: "break-all"}}>{newKey}</code>
          </p>
          <button type="button" onClick={copyKey}>
            {copied ? "Copied ✓" : "Copy key"}
          </button>
          <p className="muted">
            Store it in your server&apos;s secrets (environment variable), not in your code.
          </p>
        </article>
      )}
      <form onSubmit={createKey}>
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Website contact form)"
          maxLength={100}
        />
        <label style={{display: "inline-flex", gap: 6, alignItems: "center"}}>
          <input type="checkbox" checked={scopeSend} onChange={(e) => setScopeSend(e.target.checked)} />
          send — send mail via POST /api/v1/send
        </label>
        <label style={{display: "inline-flex", gap: 6, alignItems: "center"}}>
          <input type="checkbox" checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} />
          messages:read — list messages via GET /api/v1/messages
        </label>
        <label>
          Expires (optional){" "}
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <button className="primary" disabled={creating}>
          {creating ? "Creating…" : "Create API key"}
        </button>
      </form>
      {keys.length === 0 ? (
        <p className="muted">No API keys yet for this workspace.</p>
      ) : (
        keys.map((k) => (
          <article key={k.id}>
            <b>{k.label}</b>
            <span>
              {k.key_prefix}… · scopes: {k.scopes.join(", ") || "none"} ·{" "}
              {k.revoked_at ? "revoked " + formatDate(k.revoked_at) : "active"}
            </span>
            <span>
              Created {formatDate(k.created_at)} · Last used {formatDate(k.last_used_at)}
              {k.expires_at ? " · Expires " + formatDate(k.expires_at) : ""}
            </span>
            {!k.revoked_at &&
              (confirmRevokeId === k.id ? (
                <>
                  <button
                    type="button"
                    disabled={revoking === k.id}
                    onClick={() => revokeKey(k.id)}
                    style={{background: "#5b2333", borderColor: "#8a3a44"}}
                  >
                    {revoking === k.id ? "Revoking…" : "Click again to confirm revoke"}
                  </button>
                  <button type="button" disabled={revoking === k.id} onClick={disarmRevoke}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => armRevoke(k.id)}>
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
