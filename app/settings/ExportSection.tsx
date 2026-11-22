"use client";
import {useCallback, useEffect, useState} from "react";

// Settings → Export / backup (Phase 3b, G-30/G-31).
// "Download all my mail": POST /api/export builds a ZIP (messages as
// .eml + messages.json + metadata.json, attachments included) for the
// caller's own workspace only. Size-capped at 100 MB (the server refuses
// larger exports with a clear message — pick one mailbox and retry).
// Rate limit: 1 export / 10 min / workspace (429 with Retry-After).
// The server-side backup job (POST /api/ops/backup + the GitHub Actions
// backup workflow) is documented in docs/BACKUP.md.

type MailboxRow = {id: string; address: string};

export default function ExportSection({workspace}: {workspace: string}) {
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadMailboxes = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/mailboxes");
      const d = await r.json();
      if (r.ok) setMailboxes((d.data || []).map((b: any) => ({id: b.id, address: b.address})));
    } catch {
      // Mailbox list is a convenience for the per-mailbox option; the
      // all-mailbox export still works without it.
    }
  }, [workspace]);

  useEffect(() => {
    loadMailboxes();
  }, [loadMailboxes]);

  async function downloadExport() {
    if (!workspace || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspace, mailbox_id: mailboxId || undefined}),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.error || "Export failed.");
        return;
      }
      const blob = await r.blob();
      const count = r.headers.get("X-WorkMail-Export-Messages") || "?";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workmail-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Export downloaded — ${count} message(s) in the ZIP (messages as .eml, plus messages.json and metadata.json).`);
    } catch {
      setError("Export failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!workspace)
    return (
      <section>
        <h2>Export &amp; backup</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>Export &amp; backup</h2>
      <p>
        Download all your mail as a ZIP — every message as a .eml file, plus messages.json and metadata.json with the
        counts. Attachment files are included. Only your workspace&apos;s mail is ever in the export.
      </p>
      <p className="muted">
        Limits: 100 MB per export (over that, pick one mailbox below and export it on its own) and one export every 10
        minutes. The ZIP is verified by the server before download. A server-side backup also runs daily (encrypted
        artifacts, 90-day retention) — see docs/BACKUP.md.
      </p>
      <label>
        Mailbox (optional — leave blank for all mailboxes)
        <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
          <option value="">All mailboxes</option>
          {mailboxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.address}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" onClick={downloadExport} disabled={busy}>
        {busy ? "Building export…" : "Download all my mail (.zip)"}
      </button>
      {notice && <p className="inlineNotice">{notice}</p>}
      {error && <p className="inlineNotice">{error}</p>}
    </section>
  );
}
