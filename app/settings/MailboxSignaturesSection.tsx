"use client";
import {useCallback, useEffect, useState} from "react";

// Settings → Mailbox signatures (E5-10).
// A plain-text signature per mailbox, appended to plain-text compose
// sends from that mailbox as "\n\n-- \n" + signature. HTML signatures
// are NOT supported — the compose path appends text only, and template
// sends do not carry the signature. Empty = no signature.

export default function MailboxSignaturesSection({workspace}: {workspace: string}) {
  const [boxes, setBoxes] = useState<any[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadBoxes = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/mailboxes");
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not load mailboxes.");
        return;
      }
      setBoxes(d.data || []);
    } catch {
      setError("Could not load mailboxes.");
    }
  }, [workspace]);

  useEffect(() => {
    loadBoxes();
  }, [loadBoxes]);

  async function saveSignature(id: string) {
    const value = (edits[id] ?? "").trim();
    if (value.length > 2000) {
      setError("Signature must be 2000 characters or fewer.");
      return;
    }
    setSaving((x) => ({...x, [id]: true}));
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/mailboxes", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mailbox_id: id, signature: value}),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not save signature.");
        return;
      }
      setBoxes((x) => x.map((b) => (b.id === id ? d.data : b)));
      setEdits((x) => {
        const c = {...x};
        delete c[id];
        return c;
      });
      setNotice("Signature saved — it will be appended to plain-text sends from that mailbox.");
    } catch {
      setError("Could not save signature.");
    } finally {
      setSaving((x) => ({...x, [id]: false}));
    }
  }

  if (!workspace)
    return (
      <section>
        <h2>Mailbox signatures</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>Mailbox signatures</h2>
      <p>
        A plain-text signature per mailbox, appended to the bottom of plain-text mails sent from
        that mailbox (after a “-- ” separator line). Leave blank for no signature.
      </p>
      <p className="muted">
        Text signatures only — HTML signatures are not supported, and template sends do not carry
        the signature.
      </p>
      {boxes.length === 0 ? (
        <p className="muted">No mailboxes yet — create one above first.</p>
      ) : (
        boxes.map((b) => {
          const draft = edits[b.id] ?? b.signature ?? "";
          return (
            <article key={b.id} style={{display: "block"}}>
              <b>{b.address}</b>
              <label>
                Signature
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={draft}
                  onChange={(e) => setEdits((x) => ({...x, [b.id]: e.target.value}))}
                  placeholder={"e.g.\nBest regards,\nPriyadarshi Raj\nP.R. Digital Enterprises"}
                />
              </label>
              <button onClick={() => saveSignature(b.id)} disabled={!!saving[b.id]}>
                {saving[b.id] ? "Saving…" : "Save signature"}
              </button>
            </article>
          );
        })
      )}
      {error && <p style={{fontSize: 12, color: "#f2a6a6", margin: "8px 0 0"}}>{error}</p>}
      {notice && <p style={{fontSize: 12, color: "#8fd9b9", margin: "8px 0 0"}}>{notice}</p>}
    </section>
  );
}
