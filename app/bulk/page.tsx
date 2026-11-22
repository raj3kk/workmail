// Bulk send UI — upload a sheet, preview validation, compose one
// templated message, create a campaign, start it, watch live progress,
// and stop it. Sending is driven by polling the status endpoint (see
// lib/bulk.ts header): while a campaign is `sending`, each status poll
// advances it by one tick, so keep this page open until it finishes.
"use client";
import {useEffect, useRef, useState} from "react";

type Preview = {
  columns: string[];
  total_rows: number;
  valid_count: number;
  invalid: Array<{row: number; email: string; reason: string}>;
  duplicates_removed: number;
  suppressed: Array<{email: string; reason: string}>;
  recipients: Array<{email: string; name: string; fields: Record<string, string>; row: number}>;
  unknown_placeholders: string[];
  cap: number;
  monthly: {limit: number; used: number; remaining: number};
};
type Campaign = {
  id: string; workspace_id: string; mailbox_id: string; name: string; subject: string;
  status: string; provider?: string; total_recipients: number; sent: number; failed: number; skipped: number;
  unknown: number; pending: number; pause_reason: string | null; started_at: string | null;
  finished_at: string | null; created_at: string;
};
type RecipientRow = {id: string; email: string; name: string; status: string; provider: string | null; error: string | null; attempts: number; sent_at: string | null};

function renderTemplate(tpl: string, r: {email: string; name: string; fields: Record<string, string>}): string {
  const ctx: Record<string, string> = {email: r.email, name: r.name, ...r.fields};
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k: string) => ctx[k.toLowerCase()] ?? "");
}
function placeholdersIn(tpl: string): string[] {
  return [...new Set([...tpl.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1].toLowerCase()))];
}

export default function BulkPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [mailboxes, setMailboxes] = useState<any[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [subject, setSubject] = useState("Hello {{name}}");
  const [text, setText] = useState("Hi {{name}},\n\nThis is a message from {{company}}.");
  const [html, setHtml] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [provider, setProvider] = useState("auto");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // True while the last poll/start could not confirm the campaign state.
  // Counts on screen stay the last confirmed server summary — nothing is
  // ever advanced optimistically while this is set.
  const [statusUnknown, setStatusUnknown] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/auth/session").then((r) => r.json()).then((s) => {
      setUser(s.user || null);
      setWorkspaces(s.workspaces || []);
      if (s.workspaces?.[0]?.id) setWorkspaceId(s.workspaces[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    fetch("/api/mailboxes").then((r) => r.json()).then((d) => {
      setMailboxes(d.data || []);
      if (!mailboxId && d.data?.[0]) setMailboxId(d.data[0].id);
    }).catch(() => {});
  }, [user]);
  async function loadCampaigns() {
    if (!workspaceId) return;
    const r = await fetch(`/api/bulk/campaigns?workspace_id=${encodeURIComponent(workspaceId)}`);
    const d = await r.json();
    if (r.ok) setCampaigns(d.campaigns || []);
  }
  useEffect(() => { loadCampaigns(); }, [workspaceId]);

  // Status poll: the ONLY source of progress counts is the server
  // summary (d.campaign). On any poll failure the last confirmed
  // campaign/recipients stay on screen untouched and the UI says the
  // status is unknown — progress is never guessed or advanced locally.
  async function pollStatus(id: string) {
    let r: Response;
    let d: any;
    try {
      r = await fetch(`/api/bulk/campaigns/${id}?limit=50`);
      d = await r.json();
    } catch {
      setStatusUnknown(true);
      setNotice("Campaign status unknown — refreshing, not assuming progress. Counts below are the last confirmed server values.");
      return;
    }
    if (!r.ok) {
      setStatusUnknown(true);
      setNotice(`Campaign status unknown — refreshing, not assuming progress. ${d.error || "Could not load campaign status"}`);
      return;
    }
    setStatusUnknown(false);
    if (d.tick_error) setNotice(`Last tick reported an error (counts below are still the confirmed server values): ${d.tick_error}`);
    setCampaign(d.campaign);
    setRecipients(d.recipients || []);
    if (d.campaign.status !== "sending") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      loadCampaigns();
    }
  }
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function upload() {
    if (!file || !workspaceId) { setNotice("Pick a workspace and a .csv/.xlsx file first."); return; }
    setParsing(true);
    const form = new FormData();
    form.append("file", file);
    form.append("workspace_id", workspaceId);
    form.append("subject", subject);
    form.append("text", text);
    form.append("html", html);
    const r = await fetch("/api/bulk/parse", {method: "POST", body: form});
    const d = await r.json();
    setParsing(false);
    if (!r.ok) { setNotice(d.error || "Could not parse the file"); return; }
    setPreview(d);
    setNotice(`Parsed ${d.total_rows} rows: ${d.valid_count} valid, ${d.invalid.length} invalid, ${d.duplicates_removed} duplicates removed, ${d.suppressed.length} suppressed (excluded).`);
  }

  async function createCampaign() {
    if (!preview || !mailboxId) { setNotice("Upload and preview a file, then pick a sending mailbox."); return; }
    if (!subject.trim() || (!text.trim() && !html.trim())) { setNotice("Write a subject and a message body first."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/bulk/campaigns", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspaceId, mailbox_id: mailboxId, name: campaignName, subject, text, html, provider, recipients: preview.recipients})});
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || "Could not create the campaign"); return; }
      setCampaign(d.campaign);
      setNotice(d.monthly_warning || `Campaign created with ${d.campaign.total_recipients} recipients. Review it, then press Start.`);
      loadCampaigns();
    } catch {
      setNotice("Could not create the campaign (no response from the server). Nothing was created that we know of — refresh the campaign list before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function startCampaign() {
    if (!campaign) return;
    setBusy(true);
    let r: Response;
    let d: any;
    try {
      r = await fetch(`/api/bulk/campaigns/${campaign.id}/start`, {method: "POST"});
      d = await r.json();
    } catch {
      // No reliable answer from the server: the campaign may or may not
      // be sending. Keep the last confirmed campaign on screen and say
      // the status is unknown — never assume the start worked.
      setStatusUnknown(true);
      setNotice("Campaign status unknown — refreshing, not assuming progress. The start request got no response; the campaign may or may not be sending.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      // The server answered with a definite error (e.g. 409 already
      // sending): that IS known state, so show it. A tick_error with a
      // campaign body means some progress was confirmed — keep it.
      if (d.campaign) {
        setCampaign(d.campaign);
        setStatusUnknown(false);
        setNotice(d.tick_error ? `Start tick failed partway (confirmed progress kept): ${d.tick_error}` : (d.error || "Could not start the campaign"));
      } else {
        setNotice(d.error || "Could not start the campaign");
      }
      return;
    }
    setStatusUnknown(false);
    setCampaign(d.campaign);
    setNotice(d.tick_error ? `Campaign sending — progress updates every 2 seconds. Note: the first tick reported an error: ${d.tick_error}` : "Campaign sending — progress updates every 2 seconds. Keep this page open.");
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => pollStatus(campaign.id), 2000);
  }

  async function stopCampaign() {
    if (!campaign) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/bulk/campaigns/${campaign.id}/stop`, {method: "POST"});
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || "Could not stop the campaign"); return; }
      setCampaign(d.campaign);
      setNotice("Campaign stopped. Sent recipients stay sent; the rest stay pending.");
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      loadCampaigns();
    } catch {
      setStatusUnknown(true);
      setNotice("Campaign status unknown — refreshing, not assuming progress. The stop request got no response; the campaign may or may not have stopped.");
    } finally {
      setBusy(false);
    }
  }

  async function openCampaign(c: Campaign) {
    setCampaign(c);
    await pollStatus(c.id);
    if (c.status === "sending" && !pollRef.current) {
      pollRef.current = setInterval(() => pollStatus(c.id), 2000);
    }
  }

  if (loading) return <main className="center">Loading WorkMail…</main>;
  if (!user) return <main className="login"><div className="loginCard"><div className="logo">W</div><h1>Bulk send</h1><p className="muted">Sign in to send a bulk campaign.</p><button className="primary wide" onClick={() => { location.href = "/api/auth/login"; }}>Continue with Google</button></div></main>;

  const knownCols = preview ? ["email", "name", ...preview.columns] : [];
  const unknownInCompose = [...new Set([...placeholdersIn(subject), ...placeholdersIn(text), ...placeholdersIn(html)])].filter((p) => !knownCols.includes(p));
  const sample = preview?.recipients?.[0];
  const done = campaign ? campaign.sent + campaign.failed + campaign.skipped + campaign.unknown : 0;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo smallLogo">W</span><span><b>WorkMail</b><small>BULK SEND</small></span></div>
        <button className="nav" onClick={() => { location.href = "/"; }}>← Back to inbox</button>
        <button className="nav" onClick={() => { location.href = "/dashboard"; }}>▤ Dashboard</button>
        <div className="navLabel">WORKSPACE</div>
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          {workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <div className="navLabel">FROM MAILBOX</div>
        <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
          {mailboxes.filter((b: any) => b.workspace_id === workspaceId).map((b: any) => <option key={b.id} value={b.id}>{b.address}</option>)}
        </select>
        {mailboxes.filter((b: any) => b.workspace_id === workspaceId).length === 0 && <small className="muted">No mailbox in this workspace yet — create one in Settings first.</small>}
        <div className="navLabel">PAST CAMPAIGNS</div>
        {campaigns.length === 0 && <small className="muted">No campaigns yet.</small>}
        {campaigns.map((c) => (
          <button key={c.id} className="nav" onClick={() => openCampaign(c)}>
            <span>{c.status === "sending" ? "▶" : c.status === "completed" ? "✓" : c.status === "stopped" ? "■" : c.status === "paused_caps" ? "⏸" : "○"}</span>
            {c.name || c.subject.slice(0, 24)} · {c.status}
          </button>
        ))}
        <div className="account"><div><b>Cap: 500 recipients</b><small>per campaign (free tier)</small></div></div>
      </aside>
      <section className="content">
        <header className="header"><div><div className="eyebrow">WORKSPACE / BULK SEND</div><h1>Bulk send</h1></div></header>
        <div style={{display: "grid", gap: 16, maxWidth: 860}}>
          <section>
            <h2>1 · Upload recipients</h2>
            <p className="muted">CSV or XLSX. First row must be headers — <b>email</b> required, <b>name</b> optional, any other columns become {"{{placeholders}}"}. Max 500 recipients per campaign.</p>
            <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <button className="primary" disabled={parsing || !file} onClick={upload} style={{marginLeft: 8}}>{parsing ? "Parsing…" : "Parse & preview"}</button>
            {file && <small className="muted" style={{marginLeft: 8}}>{file.name} ({Math.round(file.size / 1024)} KB)</small>}
            {preview && (
              <div style={{marginTop: 12}}>
                <b>{preview.valid_count} valid</b> · {preview.invalid.length} invalid · {preview.duplicates_removed} duplicates removed · {preview.suppressed.length} suppressed (excluded) · monthly sends left: {preview.monthly.remaining}/{preview.monthly.limit}
                {preview.invalid.length > 0 && <div className="warn" style={{marginTop: 8}}>Invalid rows (not sent): {preview.invalid.slice(0, 5).map((x) => `row ${x.row}: ${x.email || "(blank)"} (${x.reason})`).join("; ")}{preview.invalid.length > 5 ? ` …and ${preview.invalid.length - 5} more` : ""}</div>}
                {preview.suppressed.length > 0 && <div className="warn" style={{marginTop: 8}}>Suppressed (never emailed): {preview.suppressed.slice(0, 5).map((x) => `${x.email} (${x.reason})`).join("; ")}{preview.suppressed.length > 5 ? ` …and ${preview.suppressed.length - 5} more` : ""}</div>}
                <table style={{width: "100%", marginTop: 8, fontSize: 13}}><thead><tr><th align="left">Email</th><th align="left">Name</th><th align="left">Other fields</th></tr></thead>
                  <tbody>{preview.recipients.slice(0, 10).map((r) => <tr key={r.email}><td>{r.email}</td><td>{r.name}</td><td>{Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}</td></tr>)}</tbody></table>
                {preview.recipients.length > 10 && <small className="muted">Showing 10 of {preview.recipients.length} valid recipients.</small>}
              </div>
            )}
          </section>
          <section>
            <h2>2 · Compose one message</h2>
            <p className="muted">Use {"{{name}}"} or any column name as a placeholder. Missing fields render empty — never a crash.</p>
            <label>Campaign name (optional)<input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. November launch" style={{width: "100%"}} /></label>
            <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} style={{width: "100%"}} /></label>
            <label>Text body<textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{width: "100%"}} /></label>
            <label>HTML body (optional)<textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={4} style={{width: "100%"}} placeholder="<p>Hi {{name}}, …</p>" /></label>
            <label>Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{width: "100%"}}>
                <option value="auto">Auto (fallback chain)</option>
                <option value="sendpulse">SendPulse</option>
                <option value="brevo">Brevo</option>
                <option value="mailjet">Mailjet</option>
                <option value="resend">Resend</option>
              </select>
            </label>
            <small className="muted">Auto tries providers in fallback order. A manual pick sends through ONLY that provider — no silent fallback; if it rejects, the send fails honestly.</small>
            {unknownInCompose.length > 0 && <div className="warn">Unknown placeholders (no such column — they will render empty): {unknownInCompose.map((p) => `{{${p}}}`).join(", ")}</div>}
            {sample && (
              <div style={{marginTop: 8, border: "1px solid var(--hatch-widget-border, #ddd)", padding: 12, borderRadius: 8}}>
                <b>Preview for {sample.email}</b>
                <div><small className="muted">Subject:</small> {renderTemplate(subject, sample)}</div>
                <pre style={{whiteSpace: "pre-wrap", fontSize: 13}}>{renderTemplate(text, sample)}</pre>
              </div>
            )}
            <div style={{marginTop: 12}}>
              <button className="primary" disabled={busy || !preview} onClick={createCampaign}>{busy ? "Working…" : "Create campaign"}</button>
              {preview && preview.valid_count > preview.monthly.remaining && <span className="warn" style={{marginLeft: 8}}>Heads up: {preview.valid_count} recipients but only {preview.monthly.remaining} monthly sends left — the campaign will pause at the limit.</span>}
            </div>
          </section>
          {campaign && (
            <section>
              <h2>3 · Send &amp; progress</h2>
              {/* Counts below come ONLY from the server summary (campaign) — never computed or advanced locally. */}
              <p><b>{campaign.name || campaign.subject}</b> · status: <b>{campaign.status}</b> · provider: <b>{!campaign.provider || campaign.provider === "auto" ? "Auto (fallback chain)" : campaign.provider}</b>{campaign.pause_reason ? ` — ${campaign.pause_reason}` : ""}</p>
              {statusUnknown && <div className="warn" style={{marginTop: 8}}>Status unknown — refreshing, not assuming progress. Counts below are the last confirmed server values.</div>}
              <p>{done} / {campaign.total_recipients} processed · sent {campaign.sent} · failed {campaign.failed} · skipped {campaign.skipped} · unknown {campaign.unknown} · pending {campaign.pending}</p>
              <div style={{height: 10, background: "#eee", borderRadius: 5, overflow: "hidden"}}>
                <div style={{width: `${campaign.total_recipients ? Math.round((done / campaign.total_recipients) * 100) : 0}%`, height: "100%", background: "#2563eb"}} />
              </div>
              <div style={{marginTop: 12, display: "flex", gap: 8}}>
                {(campaign.status === "draft" || campaign.status === "paused_caps") && <button className="primary" disabled={busy} onClick={startCampaign}>{campaign.status === "paused_caps" ? "Resume" : "Start sending"}</button>}
                {(campaign.status === "sending" || campaign.status === "paused_caps") && <button disabled={busy} onClick={stopCampaign}>■ Stop</button>}
                <button onClick={() => pollStatus(campaign.id)}>↻ Refresh</button>
              </div>
              {campaign.status === "sending" && <small className="muted">Sending… keep this page open; progress updates every 2 seconds.</small>}
              {recipients.length > 0 && (
                <table style={{width: "100%", marginTop: 12, fontSize: 13}}><thead><tr><th align="left">Email</th><th align="left">Status</th><th align="left">Provider</th><th align="left">Note</th></tr></thead>
                  <tbody>{recipients.map((r) => <tr key={r.id}><td>{r.email}</td><td>{r.status}</td><td>{r.provider || "—"}</td><td>{r.error || "—"}</td></tr>)}</tbody></table>
              )}
            </section>
          )}
        </div>
        {notice && <div className="notice" onClick={() => setNotice("")}>{notice} ×</div>}
      </section>
    </main>
  );
}
