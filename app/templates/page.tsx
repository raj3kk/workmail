// Templates page — list by category, create/edit with a live preview,
// set default per category, test-send to your own mailbox, delete with
// set default, test-send, two-step delete (inline confirm buttons only).
// Preview rendering is client-side with sample values and is display
// only: the server re-renders and re-sanitises at send time.
"use client";
import {useEffect, useMemo, useState} from "react";

type Template = {
  id: string; workspace_id: string; name: string; category: string;
  subject: string; html_body: string; text_body: string; variables: string[];
  is_default: number; created_at: string;
};

const CATEGORIES = [
  {value: "auth", label: "Verification / OTP"},
  {value: "welcome", label: "Welcome"},
  {value: "notification", label: "Notification"},
  {value: "newsletter", label: "Newsletter / bulk"},
  {value: "transactional", label: "Transactional / reply"},
];

function categoryLabel(v: string): string {
  return CATEGORIES.find((c) => c.value === v)?.label || v;
}

// Preview-only render: known variables get sample values, unknown ones
// stay visible as {{name}} — exactly like the server preview rule.
function renderPreview(tpl: string, ctx: Record<string, string>): string {
  return (tpl || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_w, k: string) => {
    const v = ctx[k.toLowerCase()];
    return v === undefined ? `{{${k.toLowerCase()}}}` : v;
  });
}

function extractVars(text: string): string[] {
  return [...new Set([...(text || "").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1].toLowerCase()))];
}

export default function TemplatesPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mailboxes, setMailboxes] = useState<any[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("transactional");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session").then((r) => r.json()).then((s) => {
      setUser(s.user || null);
      const w = s.workspaces?.[0];
      if (w?.id) { setWorkspaceId(w.id); setWorkspaceName(w.name || ""); }
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

  async function load() {
    if (!workspaceId) return;
    const r = await fetch(`/api/templates?workspace_id=${encodeURIComponent(workspaceId)}`);
    const d = await r.json();
    if (r.ok) setTemplates(d.templates || []);
    else setNotice(d.error || "Could not load templates");
  }
  useEffect(() => { load(); }, [workspaceId]);

  const sampleCtx = useMemo(() => ({
    name: "Priya",
    otp: "123456",
    action_url: typeof window !== "undefined" ? window.location.origin : "https://workmail-delta.vercel.app",
    sender_name: workspaceName || "Your Brand",
    unsubscribe_url: "mailto:hello@example.com?subject=Unsubscribe",
    email: user?.email || "you@example.com",
  }), [workspaceName, user]);

  const previewHtml = useMemo(() => renderPreview(html, sampleCtx), [html, sampleCtx]);
  const previewSubject = useMemo(() => renderPreview(subject, sampleCtx), [subject, sampleCtx]);
  const varsInForm = useMemo(
    () => [...new Set([...extractVars(subject), ...extractVars(html)])],
    [subject, html],
  );

  function startNew() {
    setEditingId(null);
    setName("");
    setCategory("transactional");
    setSubject("");
    setHtml("");
    setText("");
    setDeleteArmed(null);
  }
  function startEdit(t: Template) {
    setEditingId(t.id);
    setName(t.name);
    setCategory(t.category);
    setSubject(t.subject);
    setHtml(t.html_body);
    setText(t.text_body);
    setDeleteArmed(null);
    window.scrollTo({top: 0});
  }

  async function save() {
    if (!workspaceId) return;
    if (!name.trim() || !subject.trim() || !html.trim()) {
      setNotice("Name, subject and HTML body are all required.");
      return;
    }
    setBusy(true);
    try {
      const url = editingId ? `/api/templates/${encodeURIComponent(editingId)}` : "/api/templates";
      const method = editingId ? "PATCH" : "POST";
      const body: Record<string, unknown> = {workspace_id: workspaceId, name: name.trim(), category, subject, html_body: html};
      if (text.trim()) body.text_body = text;
      const r = await fetch(url, {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || "Could not save the template"); return; }
      setNotice(editingId ? "Template saved." : "Template created.");
      if (!editingId && d.template?.id) setEditingId(d.template.id);
      load();
    } catch {
      setNotice("Could not save the template (no response from the server).");
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(t: Template) {
    setBusy(true);
    const r = await fetch(`/api/templates/${encodeURIComponent(t.id)}`, {
      method: "PATCH", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({workspace_id: workspaceId, is_default: true}),
    });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) { setNotice(d.error || "Could not set the default"); return; }
    setNotice(`“${t.name}” is now the default ${categoryLabel(t.category)} template.`);
    load();
  }

  async function testSend(t: Template) {
    if (!mailboxId) { setNotice("Pick a sending mailbox first (Settings → Mailboxes)."); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/templates/${encodeURIComponent(t.id)}/test`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({workspace_id: workspaceId, mailbox_id: mailboxId}),
      });
      const d = await r.json();
      if (!r.ok) { setNotice(d.error || "Test send failed"); return; }
      setNotice(`Test send accepted by ${d.provider || "a provider"} — check your inbox for “${t.subject}”.`);
    } catch {
      setNotice("Test send got no response — check Sent before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(t: Template) {
    const r = await fetch(`/api/templates/${encodeURIComponent(t.id)}?workspace_id=${encodeURIComponent(workspaceId)}`, {method: "DELETE"});
    const d = await r.json().catch(() => null);
    if (!r.ok) { setNotice(d?.error || "Could not delete the template"); return; }
    setDeleteArmed(null);
    if (editingId === t.id) startNew();
    setNotice(`Template “${t.name}” deleted.`);
    load();
  }

  if (loading) return <main className="center">Loading WorkMail…</main>;
  if (!user) return <main className="login"><div className="loginCard"><div className="logo">W</div><h1>Templates</h1><p className="muted">Sign in to manage email templates.</p><button className="primary wide" onClick={() => { location.href = "/api/auth/login"; }}>Continue with Google</button></div></main>;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo smallLogo">W</span><span><b>WorkMail</b><small>TEMPLATES</small></span></div>
        <button className="nav" onClick={() => { location.href = "/"; }}>← Back to inbox</button>
        <button className="nav" onClick={() => { location.href = "/dashboard"; }}>▤ Dashboard</button>
        <button className="nav" onClick={() => { location.href = "/bulk"; }}>✉ Bulk send</button>
        <button className="nav selected" onClick={() => { location.href = "/templates"; }}>▦ Templates</button>
        <div className="navLabel">WORKSPACE</div>
        <div className="account"><div><b>{workspaceName || "Workspace"}</b><small>{templates.length} template{templates.length === 1 ? "" : "s"}</small></div></div>
      </aside>
      <section className="content">
        <header className="header"><div><div className="eyebrow">WORKSPACE / TEMPLATES</div><h1>Email templates</h1></div></header>
        <p className="muted" style={{maxWidth: 860}}>Every message goes out in a branded, email-safe design — table layout, inline CSS, system fonts. Real 3D/WebGL does not run inside email clients, so depth comes from layered colours and borders; see docs/TEMPLATES.md for the honest note. Variables like {"{{name}}"} and {"{{otp}}"} are filled at send time; an unknown variable blocks the send instead of going out blank.</p>
        <div style={{display: "grid", gap: 16, maxWidth: 960}}>
          <section>
            <h2>{editingId ? "Edit template" : "New template"}</h2>
            <div style={{display: "grid", gap: 10}}>
              <label>Name<input value={name} onChange={(e) => setName(e.target.value)} style={{width: "100%"}} /></label>
              <label>Category
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={{width: "100%"}}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} style={{width: "100%"}} /></label>
              <label>HTML body<textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12} style={{width: "100%", fontFamily: "monospace", fontSize: 12}} /></label>
              <label>Plain-text body (optional — auto-derived from the HTML when empty)<textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} style={{width: "100%"}} /></label>
              {varsInForm.length > 0 && <small className="muted">Variables in this template: {varsInForm.map((v) => `{{${v}}}`).join(", ")}. At send time every one needs a value — an unknown variable blocks the send.</small>}
              <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : editingId ? "Save changes" : "Create template"}</button>
                {editingId && <button disabled={busy} onClick={startNew}>New template</button>}
              </div>
            </div>
            {(html.trim() || subject.trim()) && (
              <div style={{marginTop: 16}}>
                <b>Live preview</b> <small className="muted">(sample values: name Priya, code 123456 — unknown variables stay visible)</small>
                <div style={{marginTop: 8}}><small className="muted">Subject:</small> {previewSubject}</div>
                <iframe title="Template preview" sandbox="" srcDoc={previewHtml} style={{width: "100%", minHeight: 420, border: "1px solid #283a55", borderRadius: 8, background: "#fff", marginTop: 8}} />
              </div>
            )}
          </section>
          {CATEGORIES.map((c) => {
            const list = templates.filter((t) => t.category === c.value);
            if (list.length === 0) return null;
            return (
              <section key={c.value}>
                <h2>{c.label}</h2>
                {list.map((t) => (
                  <article key={t.id} style={{border: "1px solid #283a55", borderRadius: 10, padding: 14, marginBottom: 10}}>
                    <div style={{display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center"}}>
                      <b>{t.name}</b>
                      {t.is_default === 1 && <span className="tag">DEFAULT</span>}
                      <small className="muted">{t.subject}</small>
                    </div>
                    {t.variables.length > 0 && <small className="muted" style={{display: "block", marginTop: 6}}>Variables: {t.variables.map((v) => `{{${v}}}`).join(", ")}</small>}
                    <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10}}>
                      <button onClick={() => startEdit(t)}>Edit</button>
                      {t.is_default !== 1 && <button disabled={busy} onClick={() => setDefault(t)}>Set as default</button>}
                      <button disabled={busy} onClick={() => testSend(t)}>Test send</button>
                      {deleteArmed === t.id ? (
                        <>
                          <button disabled={busy} onClick={() => confirmDelete(t)} style={{color: "#f2a6a6"}}>Confirm delete?</button>
                          <button onClick={() => setDeleteArmed(null)}>Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setDeleteArmed(t.id)} style={{color: "#f2a6a6"}}>Delete</button>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
          {templates.length === 0 && <p className="muted">No templates yet — the five defaults appear here on your first visit.</p>}
        </div>
        {notice && <div className="notice" onClick={() => setNotice("")}>{notice} ×</div>}
      </section>
    </main>
  );
}
