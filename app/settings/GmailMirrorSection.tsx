"use client";
import {useEffect, useRef, useState} from "react";

// Gmail backup mirror — Settings section (Phase 4, PRODUCTION-PLAN.md §7).
// One-way backup copy into the owner's Gmail; D1 stays the source of truth.
// The section states the honest limits in plain text (see the notice below)
// and never claims Gmail can send as the WorkMail domain.
// Disconnect uses an INLINE two-step confirmation — never a native dialog.
// The connect step hands the owner to Google consent in the browser; the
// refresh token is stored encrypted server-side and is never shown here.

interface MirrorStatus {
  connected: boolean;
  googleEmail: string | null;
  autoMirror: boolean;
  total: number;
  mirrored: number;
  skipped: number;
  unmirrored: number;
}

interface ExportResult {
  total: number;
  imported: number;
  already_mirrored: number;
  skipped: Array<{id: string; subject: string; reason: string}>;
  failed: Array<{id: string; subject: string; reason: string}>;
  verified_mirrored: number;
}

const CONFIRM_ARM_MS = 5000;

export default function GmailMirrorSection({workspace}: {workspace: string}) {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [msg, setMsg] = useState("");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [toggling, setToggling] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    if (!workspace) return;
    setLoading(true);
    try {
      const r = await fetch("/api/gmail-mirror/export?workspace_id=" + encodeURIComponent(workspace));
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || "Could not load Gmail backup status"); setStatus(null); }
      else setStatus(d);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load Gmail backup status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => setLoading(false));
    // The OAuth callback redirects back here with ?gmail_mirror=connected|error.
    try {
      const flag = new URLSearchParams(window.location.search).get("gmail_mirror");
      if (flag === "connected") setMsg("Gmail backup connected — you can now back up your mail.");
      else if (flag === "error") setMsg("Gmail backup could not be connected. Try again and approve the Google consent screen.");
    } catch { /* search params unreadable — status load above is the source of truth */ }
    return () => { if (armTimerRef.current) clearTimeout(armTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  function connect() {
    window.location.href = "/api/gmail-mirror/connect?workspace_id=" + encodeURIComponent(workspace);
  }

  async function runExport() {
    if (!workspace || exporting) return;
    setExporting(true); setResult(null); setMsg("");
    try {
      const r = await fetch("/api/gmail-mirror/export", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspace}),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || "Backup failed"); return; }
      setResult(d);
      setMsg(
        d.failed.length > 0
          ? `Backup finished with ${d.failed.length} failure(s) — ${d.imported} imported, ${d.already_mirrored} already backed up.`
          : `Backup complete — ${d.imported} imported, ${d.already_mirrored} already backed up, ${d.skipped.length} skipped.`,
      );
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setExporting(false);
    }
  }

  async function toggleAutoMirror(on: boolean) {
    if (!workspace || toggling) return;
    setToggling(true);
    try {
      const r = await fetch("/api/gmail-mirror/export", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspace, auto_mirror: on}),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || "Could not change auto-mirror"); return; }
      setStatus(d);
      setMsg(on ? "Auto-mirror on — new mail will be copied to Gmail as it arrives or is sent." : "Auto-mirror off — use the backup button when you want a copy.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not change auto-mirror");
    } finally {
      setToggling(false);
    }
  }

  function armDisconnect() {
    setConfirmingDisconnect(true);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => setConfirmingDisconnect(false), CONFIRM_ARM_MS);
  }

  async function disconnect() {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setConfirmingDisconnect(false);
    try {
      const r = await fetch("/api/gmail-mirror/disconnect", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspace}),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || "Could not disconnect Gmail backup"); return; }
      setStatus(null); setResult(null);
      setMsg("Gmail backup disconnected. Copies already in Gmail stay there; your WorkMail mail is untouched.");
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not disconnect Gmail backup");
    }
  }

  if (!workspace) return <section><h2>Gmail backup</h2><p className="muted">Loading workspace…</p></section>;

  return <section><h2>Gmail backup</h2>
    <p>Backup copy — D1 stays the source of truth. Gmail cannot send as hello@flow99.in with proper authentication; replies from Gmail come from @gmail.com.</p>
    <p className="muted">One click copies all WorkMail mail into your Gmail under the WorkMail label, with original dates and attachments. Re-running the backup imports nothing twice. Auto-mirror copies new mail as it is sent or received. Your Gmail password changing, or revoking access at Google, stops future mirroring — WorkMail keeps working from its own store.</p>
    {loading && <p className="muted">Loading backup status…</p>}
    {!loading && !status?.connected && <>
      <p className="muted">Not connected. Connecting asks Google for permission to add mail to your Gmail (gmail.insert + gmail.labels) — sign-in itself never asks for Gmail access.</p>
      <button className="primary" onClick={connect}>Connect Gmail backup</button>
    </>}
    {!loading && status?.connected && <>
      <p>Connected to Gmail{status.googleEmail ? ` (${status.googleEmail})` : ""}. {status.total} message(s) in this workspace · {status.mirrored} backed up · {status.skipped} skipped · {status.unmirrored} not yet backed up.</p>
      <button className="primary" onClick={runExport} disabled={exporting}>{exporting ? "Backing up…" : "Back up all WorkMail mail to my Gmail"}</button>
      <label style={{display: "block", marginTop: 8}}>
        <input type="checkbox" checked={status.autoMirror} disabled={toggling} onChange={e => toggleAutoMirror(e.target.checked)} /> Auto-mirror new mail
      </label>
      <p className="muted">Auto-mirror is off by default. When on, newly sent and received mail is copied to Gmail in the background — a failed copy never blocks sending or delivery.</p>
      {confirmingDisconnect ? <>
        <button onClick={disconnect}>Click again to confirm disconnect</button>
        <button onClick={() => setConfirmingDisconnect(false)}>Cancel</button>
      </> : <button onClick={armDisconnect}>Disconnect Gmail backup</button>}
    </>}
    {result && <article>
      <b>Backup result</b>
      <p>{result.imported} imported · {result.already_mirrored} already backed up · {result.skipped.length} skipped · {result.failed.length} failed · {result.verified_mirrored} verified in WorkMail.</p>
      {result.skipped.length > 0 && <><p>Skipped:</p><ul>{result.skipped.map(s => <li key={s.id}>{s.subject} — {s.reason}</li>)}</ul></>}
      {result.failed.length > 0 && <><p>Failed (try the backup again — already-backed-up mail is not re-imported):</p><ul>{result.failed.map(s => <li key={s.id}>{s.subject} — {s.reason}</li>)}</ul></>}
    </article>}
    {msg && <p className="inlineNotice">{msg}</p>}
  </section>;
}
