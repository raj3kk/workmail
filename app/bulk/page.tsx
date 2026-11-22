// Bulk send UI — paste a recipient list OR upload a sheet, preview
// validation, compose one message (manual or template, SAME or
// personalized), attach files, create a campaign, start it, watch live
// progress, and stop it. Sending is driven by polling the status
// endpoint (see lib/bulk.ts header): while a campaign is `sending`,
// each status poll advances it by one tick, so keep this page open
// until it finishes.
//
// Bulk v2 (E3 + E5-5, migration 0008): mailbox select (sidebar + §2),
// paste-a-list with a live "kitne ko jayega" count, recipient checkboxes,
// SAME vs personalized toggle, one attachment set per campaign (KV via
// POST /api/attachments, 2 MB/file, 1 MB total per message — the
// SendPulse free-tier cap), and a "Draft with AI" box that calls
// POST /api/ai/draft (built by the UX-Inbox worker — this page only
// calls it; a 404 means the endpoint is not live yet, not a bug here).
"use client";
import {useEffect, useMemo, useRef, useState} from "react";

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
  status: string; provider?: string; template_id?: string | null; personalized?: boolean;
  attachments?: Array<{file_name: string; size_bytes: number; content_type?: string; object_key?: string}>;
  total_recipients: number; sent: number; failed: number; skipped: number;
  unknown: number; pending: number; pause_reason: string | null; started_at: string | null;
  finished_at: string | null; created_at: string;
};
type RecipientRow = {id: string; email: string; name: string; status: string; provider: string | null; error: string | null; attempts: number; sent_at: string | null};
type PastedRecipient = {email: string; name: string; fields: Record<string, string>; row: number};
type AttachRef = {object_key: string; file_name: string; content_type: string; size_bytes: number};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// INTERIM disposable-domain list — mirrors lib/bulk.ts DISPOSABLE_DOMAINS
// (server-only module, so the client carries its own copy for the live
// parse; the server re-checks authoritatively at creation. Phase 3b
// G-12 centralises this into lib/email-validation.ts.)
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "anonymbox.com", "bugmenot.com", "deadaddress.com",
  "dispostable.com", "dropmail.me", "emailfake.com", "emailondeck.com",
  "fakeinbox.com", "filzmail.com", "getnada.com", "guerrillamail.com",
  "guerrillamailblock.com", "incognitomail.com", "jetable.org", "kasmail.com",
  "mailcatch.com", "maildrop.cc", "mailinator.com", "mailmetrash.com",
  "mailnesia.com", "mintemail.com", "mohmal.com", "mytemp.email",
  "nobulk.com", "nurfuerspam.de", "pookmail.com", "sharklasers.com",
  "shitmail.me", "spambox.us", "spamgourmet.com", "temp-mail.io",
  "temp-mail.org", "tempail.com", "tempinbox.com", "tempmail.com",
  "tempmailaddress.com", "tmpmail.org", "trash-mail.com", "trashmail.com",
  "throwawaymail.com", "yopmail.com",
]);

function renderTemplate(tpl: string, r: {email: string; name: string; fields: Record<string, string>}): string {
  const ctx: Record<string, string> = {email: r.email, name: r.name, ...r.fields};
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k: string) => ctx[k.toLowerCase()] ?? "");
}
function placeholdersIn(tpl: string): string[] {
  return [...new Set([...tpl.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1].toLowerCase()))];
}

/** Client-side mirror of lib/bulk.ts parsePastedRecipients (live preview
 *  only — the server re-parses and re-validates at creation, including
 *  the suppression check this preview cannot do). */
function parsePasteClient(text: string): {
  recipients: PastedRecipient[];
  invalid: Array<{row: number; email: string; reason: string}>;
  duplicatesRemoved: number;
  disposableCount: number;
} {
  const tokens = text.split(/[\n,;]+/).map((t) => t.trim()).filter((t) => t !== "");
  const recipients: PastedRecipient[] = [];
  const invalid: Array<{row: number; email: string; reason: string}> = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  let disposableCount = 0;
  tokens.forEach((token, idx) => {
    const row = idx + 1;
    const angled = /^(.*)<\s*([^<>\s]+)\s*>$/.exec(token);
    const name = angled ? angled[1].trim().replace(/^["']|["']$/g, "") : "";
    const email = (angled ? angled[2] : token).trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      invalid.push({row, email: token, reason: "invalid_email"});
      return;
    }
    const domain = email.split("@")[1] || "";
    if (DISPOSABLE_DOMAINS.has(domain)) {
      invalid.push({row, email, reason: "disposable_domain"});
      disposableCount += 1;
      return;
    }
    if (seen.has(email)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(email);
    recipients.push({email, name, fields: {}, row});
  });
  return {recipients, invalid, duplicatesRemoved, disposableCount};
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
  // Bulk v2: recipient source — paste a list (default) or upload a file.
  const [source, setSource] = useState<"paste" | "file">("paste");
  const [pasteText, setPasteText] = useState("");
  // Emails the user unchecked in the pasted list (excluded from the campaign).
  const [excluded, setExcluded] = useState<string[]>([]);
  const [subject, setSubject] = useState("Hello {{name}}");
  const [text, setText] = useState("Hi {{name}},\n\nThis is a message from WorkMail.");
  const [html, setHtml] = useState("");
  const [templates, setTemplates] = useState<any[]>([]);
  const [templateId, setTemplateId] = useState("");
  // Manual message vs template are mutually exclusive — one mode at a time.
  const [messageMode, setMessageMode] = useState<"manual" | "template">("manual");
  // Bulk v2: SAME = one identical body for everyone; personalized =
  // {{name}} / {{email}} / CSV columns rendered per recipient.
  const [personalized, setPersonalized] = useState(true);
  // Bulk v2: one attachment set per campaign (uploaded via /api/attachments).
  const [attachFiles, setAttachFiles] = useState<AttachRef[]>([]);
  const [attUploading, setAttUploading] = useState(false);
  // Bulk v2: AI drafting (POST /api/ai/draft — UX-Inbox worker's endpoint).
  const [aiTopic, setAiTopic] = useState("");
  const [aiTone, setAiTone] = useState("friendly");
  const [aiBusy, setAiBusy] = useState(false);
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
  // Templates (Phase 1): a picked template renders per recipient at
  // send time; its variables must be recipient columns (checked by the
  // server at creation). The text/HTML boxes are then unused.
  useEffect(() => {
    if (!workspaceId) return;
    fetch(`/api/templates?workspace_id=${encodeURIComponent(workspaceId)}`).then((r) => r.json()).then((d) => {
      if (d.templates) setTemplates(d.templates);
    }).catch(() => {});
  }, [workspaceId]);
  const selectedTemplate = templates.find((t: any) => t.id === templateId) || null;

  // Live paste parse — "kitne ko jayega" count updates as you type.
  const pasteParsed = useMemo(() => parsePasteClient(pasteText), [pasteText]);
  // Unchecking removes a recipient from the campaign (count updates).
  const pasteSelected = pasteParsed.recipients.filter((r) => !excluded.includes(r.email));
  const effectiveRecipients = source === "paste" ? pasteSelected : (preview?.recipients || []);
  const knownCols = source === "paste"
    ? ["email", "name"]
    : (preview ? ["email", "name", ...preview.columns] : []);

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

  async function uploadAttachment(f: File) {
    if (!workspaceId || !mailboxId) { setNotice("Pick a workspace and a sending mailbox first."); return; }
    if (f.size < 1 || f.size > 2 * 1024 * 1024) { setNotice(`"${f.name}" is ${Math.round(f.size / 1024)} KB — bulk attachments allow at most 2 MB per file.`); return; }
    const totalNow = attachFiles.reduce((s, a) => s + a.size_bytes, 0);
    if (totalNow + f.size > 1 * 1024 * 1024) { setNotice(`Adding "${f.name}" would exceed the 1 MB total per message (SendPulse free tier). Current total: ${Math.round(totalNow / 1024)} KB of 1 MB.`); return; }
    if (attachFiles.length >= 10) { setNotice("At most 10 attachments per campaign."); return; }
    setAttUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mailbox_id", mailboxId);
      fd.append("workspace_id", workspaceId);
      const r = await fetch("/api/attachments", {method: "POST", body: fd});
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || "Attachment upload failed"); return; }
      setAttachFiles((x) => [...x, d.attachment]);
    } catch {
      setNotice("Attachment upload failed (no response from the server).");
    } finally {
      setAttUploading(false);
    }
  }

  async function aiDraft() {
    if (!aiTopic.trim()) { setNotice("Write a short topic first — e.g. “November launch offer for customers”."); return; }
    if (!workspaceId || !mailboxId) { setNotice("Pick a workspace and a sending mailbox first."); return; }
    setAiBusy(true);
    try {
      const r = await fetch("/api/ai/draft", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspaceId, mailbox_id: mailboxId, topic: aiTopic.trim(), tone: aiTone})});
      let d: any = {};
      try { d = await r.json(); } catch { d = {}; }
      if (!r.ok) {
        if (r.status === 404) {
          setNotice("AI drafting is not available yet — POST /api/ai/draft does not exist on the server (the drafting service is still being built). Your topic is kept above; try again once it lands.");
        } else {
          setNotice(d.error || d.message || "AI draft failed.");
        }
        return;
      }
      const draft = d.draft || d;
      const newSubject = typeof draft.subject === "string" ? draft.subject : "";
      const newBody = typeof draft.body === "string" ? draft.body : (typeof draft.text === "string" ? draft.text : "");
      if (!newSubject && !newBody) { setNotice("AI drafting returned an empty draft — nothing was filled in."); return; }
      // Draft fills the MANUAL message fields for review/editing — nothing sends automatically.
      setMessageMode("manual");
      setTemplateId("");
      if (newSubject) setSubject(newSubject);
      if (newBody) setText(newBody);
      setNotice("AI draft ready — review and edit it below before creating the campaign. Nothing was sent.");
    } catch {
      setNotice("AI draft failed (no response from the server). Nothing was filled in.");
    } finally {
      setAiBusy(false);
    }
  }

  async function createCampaign() {
    if (!mailboxId) { setNotice("Pick a sending mailbox first."); return; }
    if (effectiveRecipients.length === 0) { setNotice(source === "paste" ? "Paste at least one valid recipient address first." : "Upload and preview a file first."); return; }
    if (messageMode === "template" && !templateId) { setNotice("Pick a template, or switch to a manual message."); return; }
    if (messageMode === "manual" && (!subject.trim() || (!text.trim() && !html.trim()))) { setNotice("Write a subject and a message body first, or pick a template."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/bulk/campaigns", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspaceId, mailbox_id: mailboxId, name: campaignName, subject, text, html, provider, template_id: messageMode === "template" ? (templateId || undefined) : undefined, personalized, attachments: attachFiles, recipients: effectiveRecipients})});
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

  // Manual-message placeholders: in SAME mode only the automatic
  // {{sender_name}} / {{unsubscribe_url}} are allowed; in personalized
  // mode any recipient column is allowed. Unknown variables now BLOCK
  // campaign creation on the server (strict rule) — they are shown here
  // before you press Create, not silently rendered empty.
  const composePlaceholders = messageMode === "template" ? [] : [...new Set([...placeholdersIn(subject), ...placeholdersIn(text), ...placeholdersIn(html)])];
  const unknownInCompose = composePlaceholders.filter((p) => {
    if (p === "sender_name" || p === "unsubscribe_url") return false;
    if (!personalized) return true;
    return !knownCols.includes(p);
  });
  const sample = effectiveRecipients[0];
  // SAME-mode preview renders with no per-recipient values (the message
  // is identical for everyone); personalized preview uses the first
  // recipient's values.
  const previewRecipient = sample
    ? (personalized ? sample : {email: "", name: "", fields: {}})
    : undefined;
  const done = campaign ? campaign.sent + campaign.failed + campaign.skipped + campaign.unknown : 0;
  const attachTotal = attachFiles.reduce((s, a) => s + a.size_bytes, 0);
  const wsMailboxes = mailboxes.filter((b: any) => b.workspace_id === workspaceId);
  const activeMailbox = wsMailboxes.find((b: any) => b.id === mailboxId);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo smallLogo">W</span><span><b>WorkMail</b><small>BULK SEND</small></span></div>
        <button className="nav" onClick={() => { location.href = "/"; }}>← Back to inbox</button>
        <button className="nav" onClick={() => { location.href = "/dashboard"; }}>▤ Dashboard</button>
        <button className="nav" onClick={() => { location.href = "/templates"; }}>▦ Templates</button>
        <div className="navLabel">WORKSPACE</div>
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          {workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <div className="navLabel">FROM MAILBOX</div>
        <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
          {wsMailboxes.map((b: any) => <option key={b.id} value={b.id}>{b.address}</option>)}
        </select>
        {wsMailboxes.length === 0 && <small className="muted">No mailbox in this workspace yet — create one in Settings first.</small>}
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
            <h2>1 · Recipients — paste a list or upload a file</h2>
            <div style={{display: "flex", gap: 8, marginBottom: 8}}>
              <button className={source === "paste" ? "primary" : ""} onClick={() => setSource("paste")}>Paste a list</button>
              <button className={source === "file" ? "primary" : ""} onClick={() => setSource("file")}>Upload CSV / XLSX</button>
            </div>
            {source === "paste" ? (
              <>
                <p className="muted">One address per line, or comma-separated. <b>“Name &lt;email@example.com&gt;”</b> also works. Suppressed addresses are excluded at creation; temp-mail domains are rejected.</p>
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6} style={{width: "100%"}} placeholder={"priya@example.com\nrahul@example.com, “Asha Verma” <asha@example.com>"} />
                <p style={{marginTop: 8}}>
                  <b>{pasteSelected.length} recipient{pasteSelected.length === 1 ? "" : "s"}</b> will receive this campaign
                  {pasteParsed.recipients.length !== pasteSelected.length && ` (${pasteParsed.recipients.length - pasteSelected.length} unchecked)`}
                  {pasteParsed.duplicatesRemoved > 0 && ` · ${pasteParsed.duplicatesRemoved} duplicate${pasteParsed.duplicatesRemoved === 1 ? "" : "s"} removed`}
                  {pasteParsed.invalid.length > 0 && ` · ${pasteParsed.invalid.length} invalid (not sent)`}
                </p>
                {pasteParsed.invalid.length > 0 && <div className="warn" style={{marginTop: 8}}>Not sent — fix or remove these lines: {pasteParsed.invalid.slice(0, 8).map((x) => `#${x.row}: ${x.email} (${x.reason === "disposable_domain" ? "temp-mail domain" : "invalid email"})`).join("; ")}{pasteParsed.invalid.length > 8 ? ` …and ${pasteParsed.invalid.length - 8} more` : ""}</div>}
                {pasteParsed.recipients.length > 0 && (
                  <>
                    <div style={{marginTop: 8, display: "flex", gap: 8}}>
                      <button onClick={() => setExcluded([])}>Select all</button>
                      <button onClick={() => setExcluded(pasteParsed.recipients.map((r) => r.email))}>Select none</button>
                    </div>
                    <table style={{width: "100%", marginTop: 8, fontSize: 13}}><thead><tr><th align="left"></th><th align="left">Email</th><th align="left">Name</th></tr></thead>
                      <tbody>{pasteParsed.recipients.slice(0, 50).map((r) => (
                        <tr key={r.email}>
                          <td><input type="checkbox" checked={!excluded.includes(r.email)} onChange={(e) => setExcluded((x) => e.target.checked ? x.filter((a) => a !== r.email) : [...x, r.email])} aria-label={`Include ${r.email}`} /></td>
                          <td>{r.email}</td><td>{r.name || "—"}</td>
                        </tr>
                      ))}</tbody></table>
                    {pasteParsed.recipients.length > 50 && <small className="muted">Showing 50 of {pasteParsed.recipients.length} recipients — all {pasteParsed.recipients.length} are included unless unchecked.</small>}
                  </>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
          </section>
          <section>
            <h2>2 · Compose one message</h2>
            <label>Send from (mailbox)
              <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} style={{width: "100%"}}>
                {wsMailboxes.map((b: any) => <option key={b.id} value={b.id}>{b.address}{b.display_name ? ` (${b.display_name})` : ""}</option>)}
              </select>
            </label>
            {activeMailbox && <small className="muted">Sends go from {activeMailbox.address}{activeMailbox.display_name ? ` as “${activeMailbox.display_name}”` : ""}.</small>}
            <div style={{display: "flex", gap: 8, marginTop: 12}}>
              <button className={messageMode === "manual" ? "primary" : ""} onClick={() => { setMessageMode("manual"); setTemplateId(""); }}>Type the message manually</button>
              <button className={messageMode === "template" ? "primary" : ""} onClick={() => setMessageMode("template")}>Use a template</button>
            </div>
            <p className="muted">Manual message and template are mutually exclusive — pick one. {messageMode === "manual" ? "Type the subject and body below." : "A template renders per recipient at send time."}</p>
            <label>Campaign name (optional)<input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. November launch" style={{width: "100%"}} /></label>
            {messageMode === "template" && (
              <>
                <label>Template
                  <select value={templateId} onChange={(e) => {
                    const id = e.target.value;
                    setTemplateId(id);
                    if (id) {
                      const t = templates.find((x: any) => x.id === id);
                      if (t && t.subject) setSubject(t.subject);
                    }
                  }} style={{width: "100%"}}>
                    <option value="">Pick a template…</option>
                    {templates.map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.category}){t.is_default ? " — default" : ""}</option>)}
                  </select>
                </label>
                {selectedTemplate && <small className="muted">Template “{selectedTemplate.name}” will render for each recipient at send time. Its variables ({(selectedTemplate.variables || []).map((v: string) => `{{${v}}}`).join(", ") || "none"}) must come from recipient columns — the server checks this when the campaign is created.</small>}
              </>
            )}
            <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} style={{width: "100%"}} /></label>
            <label>Text body<textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{width: "100%"}} disabled={messageMode === "template"} /></label>
            <label>HTML body (optional)<textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={4} style={{width: "100%"}} placeholder="<p>Hi {{name}}, …</p>" disabled={messageMode === "template"} /></label>
            <div style={{border: "1px solid var(--hatch-widget-border, #ddd)", padding: 12, borderRadius: 8, marginTop: 8}}>
              <b>✦ Draft with AI</b>
              <p className="muted">Short topic → AI writes the subject + body into the manual fields above for your review. Nothing sends automatically.</p>
              <label>Topic<input value={aiTopic} onChange={(e) => setAiTopic(e.target.value)} placeholder="e.g. November launch offer for customers" style={{width: "100%"}} /></label>
              <label>Tone
                <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} style={{width: "100%"}}>
                  <option value="friendly">Friendly</option>
                  <option value="formal">Formal</option>
                  <option value="short">Short</option>
                </select>
              </label>
              <button className="primary" disabled={aiBusy} onClick={aiDraft} style={{marginTop: 8}}>{aiBusy ? "Drafting…" : "✦ Draft with AI"}</button>
            </div>
            <label style={{marginTop: 12}}>Same or personalized?
              <select value={personalized ? "personalized" : "same"} onChange={(e) => setPersonalized(e.target.value === "personalized")} style={{width: "100%"}}>
                <option value="personalized">Personalized — {"{{name}}"}, {"{{email}}"} and list columns render per recipient</option>
                <option value="same">SAME — one identical message for everyone (no per-recipient variables)</option>
              </select>
            </label>
            {!personalized && <small className="muted">SAME mode: the message must not use {"{{name}}"}, {"{{email}}"} or list columns — the server rejects those at creation. Only {"{{sender_name}}"} and {"{{unsubscribe_url}}"} are allowed.</small>}
            {personalized && <small className="muted">Personalized: use {"{{name}}"} or any column name as a placeholder. A variable no recipient supplies blocks creation — values are never guessed or dropped silently.</small>}
            <label>Attachments (one set for the whole campaign)
              <input type="file" multiple onChange={(e) => {
                const files = Array.from(e.target.files || []);
                files.forEach((f) => uploadAttachment(f));
                e.target.value = "";
              }} />
            </label>
            <small className="muted">Max 2 MB per file, max 1 MB total per message (SendPulse free-tier cap), max 10 files. Current total: {Math.round(attachTotal / 1024)} KB of 1 MB.</small>
            {attUploading && <small className="muted" style={{marginLeft: 8}}>Uploading…</small>}
            {attachFiles.length > 0 && (
              <ul style={{fontSize: 13, marginTop: 8}}>
                {attachFiles.map((a) => (
                  <li key={a.object_key}>{a.file_name} ({Math.round(a.size_bytes / 1024)} KB) <button onClick={() => setAttachFiles((x) => x.filter((y) => y.object_key !== a.object_key))}>Remove</button></li>
                ))}
              </ul>
            )}
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
            {unknownInCompose.length > 0 && <div className="warn">Unknown placeholders — campaign creation will be blocked until these are fixed: {unknownInCompose.map((p) => `{{${p}}}`).join(", ")}</div>}
            {previewRecipient && messageMode === "manual" && (
              <div style={{marginTop: 8, border: "1px solid var(--hatch-widget-border, #ddd)", padding: 12, borderRadius: 8}}>
                <b>Preview {personalized && sample ? `for ${sample.email}` : "(same message for everyone)"}</b>
                <div><small className="muted">Subject:</small> {renderTemplate(subject, previewRecipient)}</div>
                <pre style={{whiteSpace: "pre-wrap", fontSize: 13}}>{renderTemplate(text, previewRecipient)}</pre>
              </div>
            )}
            <div style={{marginTop: 12}}>
              <button className="primary" disabled={busy || effectiveRecipients.length === 0} onClick={createCampaign}>{busy ? "Working…" : "Create campaign"}</button>
              {source === "file" && preview && preview.valid_count > preview.monthly.remaining && <span className="warn" style={{marginLeft: 8}}>Heads up: {preview.valid_count} recipients but only {preview.monthly.remaining} monthly sends left — the campaign will pause at the limit.</span>}
            </div>
          </section>
          {campaign && (
            <section>
              <h2>3 · Send &amp; progress</h2>
              {/* Counts below come ONLY from the server summary (campaign) — never computed or advanced locally. */}
              <p><b>{campaign.name || campaign.subject}</b> · status: <b>{campaign.status}</b> · provider: <b>{!campaign.provider || campaign.provider === "auto" ? "Auto (fallback chain)" : campaign.provider}</b>{campaign.template_id ? ` · template: ${templates.find((t: any) => t.id === campaign.template_id)?.name || campaign.template_id}` : ""} · {campaign.personalized === false ? "SAME message" : "personalized"}{campaign.attachments && campaign.attachments.length > 0 ? ` · attachments: ${campaign.attachments.map((a) => `${a.file_name} (${Math.round(a.size_bytes / 1024)} KB)`).join(", ")}` : ""}{campaign.pause_reason ? ` — ${campaign.pause_reason}` : ""}</p>
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
