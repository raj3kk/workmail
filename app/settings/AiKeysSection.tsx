"use client";
import {useCallback, useEffect, useRef, useState} from "react";

// Settings → AI drafting keys (E4, BYOK).
// The user adds their OWN Gemini and/or Groq API key for the
// "Draft with AI" helper in compose (and bulk). Keys are stored
// ENCRYPTED in D1 (AES-256-GCM, same as provider credentials) and
// are never shown again — the UI shows only the last 4 characters.
// Per key the user picks one model from the active/useful list for
// that provider (lib/ai-draft.ts catalogue); the draft call uses
// exactly that model and fails naming it if it is retired — no
// silent fallback. Delete uses an inline two-step confirm (click
// once to arm, click again to delete) — never window.confirm().
// Separate from the trained AI agent (Train AI agent section).

const CONFIRM_ARM_MS = 5000;

type AiKeyRow = {
  id: string;
  provider: "gemini" | "groq";
  model: string;
  last4: string;
  created_at: string;
};

type ModelInfo = {id: string; label: string; note?: string};

function formatDate(v: string | null): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}

export default function AiKeysSection({workspace}: {workspace: string}) {
  const [keys, setKeys] = useState<AiKeyRow[]>([]);
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [provider, setProvider] = useState<"gemini" | "groq">("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [modelSaving, setModelSaving] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadKeys = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/ai/keys?workspace_id=" + encodeURIComponent(workspace));
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not load AI keys.");
        return;
      }
      setKeys(d.keys || []);
      setModels(d.models || {});
    } catch {
      setError("Could not load AI keys.");
    }
  }, [workspace]);

  useEffect(() => {
    loadKeys();
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, [loadKeys]);

  // Default model follows the provider picker until the user picks one.
  useEffect(() => {
    const list = models[provider] || [];
    if (list.length && !list.some((m) => m.id === model)) setModel(list[0].id);
  }, [provider, models, model]);

  function disarmDelete() {
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setConfirmDeleteId("");
  }

  function armDelete(id: string) {
    setError("");
    setNotice("");
    setConfirmDeleteId(id);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => setConfirmDeleteId(""), CONFIRM_ARM_MS);
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    if (apiKey.trim().length < 10) {
      setError("Paste the full API key from the provider dashboard.");
      return;
    }
    if (!model) {
      setError("Pick a model for this key.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/ai/keys", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspace, provider, api_key: apiKey.trim(), model}),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not save AI key.");
        return;
      }
      setApiKey("");
      setNotice(
        `Saved ${provider} key (••••${d.key?.last4 || ""}) with model ${d.key?.model || model}. The key is encrypted and will never be shown again.`,
      );
      loadKeys();
    } catch {
      setError("Could not save AI key.");
    } finally {
      setSaving(false);
    }
  }

  async function changeModel(id: string, nextModel: string) {
    if (!nextModel) return;
    setModelSaving(id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/ai/keys/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model: nextModel}),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not change model.");
        return;
      }
      setNotice(`Model changed to ${nextModel}. Drafts will use exactly this model.`);
      loadKeys();
    } catch {
      setError("Could not change model.");
    } finally {
      setModelSaving("");
    }
  }

  async function deleteKey(id: string) {
    disarmDelete();
    setDeleting(id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/ai/keys/" + encodeURIComponent(id), {method: "DELETE"});
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not delete AI key.");
        return;
      }
      setNotice("AI key deleted — drafting with that key stops immediately.");
      loadKeys();
    } catch {
      setError("Could not delete AI key.");
    } finally {
      setDeleting("");
    }
  }

  if (!workspace)
    return (
      <section>
        <h2>AI drafting keys (your own)</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  const providerModels = models[provider] || [];
  const savedProviders = new Set(keys.map((k) => k.provider));

  return (
    <section>
      <h2>AI drafting keys (your own)</h2>
      <p>
        “Draft with AI” in compose writes a draft from a short topic you type — you review and
        edit it before anything is sent. It uses <b>your own</b> Gemini or Groq key when one is
        saved here (Gemini first if both are set). Without a key it tries Cloudflare Workers AI
        if configured; otherwise it tells you to add a key instead of inventing a draft.
      </p>
      <p className="muted">
        Keys are encrypted server-side (AES-256-GCM) and never shown again — only the last 4
        characters are displayed. Never paste a key into chat or commit it to GitHub. This is a
        drafting helper only, separate from the trained AI agent above.
      </p>
      <form onSubmit={saveKey}>
        <select value={provider} onChange={(e) => setProvider(e.target.value as "gemini" | "groq")}>
          <option value="gemini">Gemini (Google AI Studio key)</option>
          <option value="groq">Groq (GroqCloud key)</option>
        </select>
        <input
          required
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider === "gemini" ? "Gemini API key (AIza…)" : "Groq API key (gsk_…)"}
          autoComplete="off"
        />
        <label>
          Model{" "}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {providerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : savedProviders.has(provider) ? "Replace saved key" : "Save key (encrypted)"}
        </button>
      </form>
      {keys.length === 0 ? (
        <p className="muted">No AI drafting keys saved yet.</p>
      ) : (
        keys.map((k) => {
          const list = models[k.provider] || [];
          return (
            <article key={k.id}>
              <b>{k.provider === "gemini" ? "Gemini" : "Groq"}</b>
              <span>
                ••••{k.last4} · saved {formatDate(k.created_at)}
              </span>
              <label>
                Model{" "}
                <select
                  value={k.model}
                  disabled={modelSaving === k.id}
                  onChange={(e) => changeModel(k.id, e.target.value)}
                >
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {!list.some((m) => m.id === k.model) && <option value={k.model}>{k.model} (no longer listed — pick a current model)</option>}
                </select>
              </label>
              {confirmDeleteId === k.id ? (
                <>
                  <button
                    type="button"
                    disabled={deleting === k.id}
                    onClick={() => deleteKey(k.id)}
                    style={{background: "#5b2333", borderColor: "#8a3a44"}}
                  >
                    {deleting === k.id ? "Deleting…" : "Click again to confirm delete"}
                  </button>
                  <button type="button" disabled={deleting === k.id} onClick={disarmDelete}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => armDelete(k.id)}>
                  Delete key
                </button>
              )}
            </article>
          );
        })
      )}
      {error && <p style={{fontSize: 12, color: "#f2a6a6", margin: "8px 0 0"}}>{error}</p>}
      {notice && <p style={{fontSize: 12, color: "#8fd9b9", margin: "8px 0 0"}}>{notice}</p>}
    </section>
  );
}
