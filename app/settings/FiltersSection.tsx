"use client";
import {useCallback, useEffect, useState} from "react";

// Settings → Mail filters (S3, E5-2 remainder).
// The mail-rules ENGINE already existed (lib/filters.ts — evaluated on
// every inbound mail by /api/inbound) and the CRUD API already existed
// (/api/filters), but there was NO UI anywhere to create or manage a
// rule: rules could only be made through the API. This section is that
// UI. A rule: one or more conditions (field + operator + value, ALL or
// ANY must match) and actions (move to a folder, mark read / starred /
// important, add labels). Rules run on INBOUND mail only, in mailbox
// scope first then workspace-wide; a disabled rule never runs. Delete
// uses an inline two-step confirm — never window.confirm().

type Condition = {field: string; op: string; value: string};
type RuleRow = {
  id: string;
  workspace_id: string;
  mailbox_id: string | null;
  name: string;
  conditions: string | Record<string, any>;
  actions: string | Record<string, any>;
  is_enabled: number | boolean;
  created_at: string;
};

const FIELDS = ["from", "to", "subject", "body", "has_attachment"];
const OPS = ["contains", "equals", "starts_with", "ends_with", "is"];
const FOLDERS = ["inbox", "archive", "trash", "spam"];

function parseJson(v: string | Record<string, any>): Record<string, any> {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch {
    return {};
  }
}

function describeConditions(c: Record<string, any>): string {
  const rules = Array.isArray(c.rules) ? c.rules : [];
  if (!rules.length) return "no conditions (never fires)";
  const match = c.match === "any" ? "ANY" : "ALL";
  return `${match} of: ` + rules.map((r: any) => `${r.field} ${r.op} “${r.value}”`).join("; ");
}

function describeActions(a: Record<string, any>): string {
  const parts: string[] = [];
  if (a.move_to_folder) parts.push(`move to ${a.move_to_folder}`);
  if (a.mark_read) parts.push("mark read");
  if (a.mark_starred) parts.push("mark starred");
  if (a.mark_important) parts.push("mark important");
  if (Array.isArray(a.add_labels) && a.add_labels.length) parts.push(`add labels (${a.add_labels.length})`);
  return parts.length ? parts.join(" · ") : "no actions";
}

export default function FiltersSection({workspace}: {workspace: string}) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [labels, setLabels] = useState<any[]>([]);
  const [boxes, setBoxes] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<Condition[]>([{field: "from", op: "contains", value: ""}]);
  const [moveTo, setMoveTo] = useState("");
  const [markRead, setMarkRead] = useState(false);
  const [markStarred, setMarkStarred] = useState(false);
  const [markImportant, setMarkImportant] = useState(false);
  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const loadAll = useCallback(async () => {
    if (!workspace) return;
    try {
      const [fr, lr, br] = await Promise.all([
        fetch(`/api/filters?workspace_id=${encodeURIComponent(workspace)}`, {cache: "no-store"}),
        fetch(`/api/labels?workspace_id=${encodeURIComponent(workspace)}`, {cache: "no-store"}),
        fetch("/api/mailboxes", {cache: "no-store"}),
      ]);
      const fd = await fr.json().catch(() => null);
      if (!fr.ok) {
        setError(fd?.error || "Could not load mail filters.");
        return;
      }
      setRules(fd.rules || []);
      const ld = await lr.json().catch(() => null);
      if (lr.ok) setLabels(ld.labels || []);
      const bd = await br.json().catch(() => null);
      if (br.ok) setBoxes(bd.data || []);
    } catch {
      setError("Could not load mail filters.");
    }
  }, [workspace]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function setCondition(i: number, patch: Partial<Condition>) {
    setConditions((xs) => xs.map((c, j) => (j === i ? {...c, ...patch} : c)));
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!name.trim()) {
      setError("Give the rule a name.");
      return;
    }
    const clean = conditions.filter((c) => c.value.trim() !== "");
    if (!clean.length) {
      setError("Add at least one condition with a value.");
      return;
    }
    const actions: Record<string, any> = {};
    if (moveTo) actions.move_to_folder = moveTo;
    if (markRead) actions.mark_read = true;
    if (markStarred) actions.mark_starred = true;
    if (markImportant) actions.mark_important = true;
    if (addLabels.length) actions.add_labels = addLabels;
    if (!Object.keys(actions).length) {
      setError("Pick at least one action (move, mark, or add a label).");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch("/api/filters", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          workspace_id: workspace,
          mailbox_id: mailboxId || undefined,
          name: name.trim(),
          conditions: {match, rules: clean.map((c) => ({field: c.field, op: c.op, value: c.value.trim()}))},
          actions,
        }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError(d?.error || "Could not create rule.");
        return;
      }
      setName("");
      setMailboxId("");
      setMatch("all");
      setConditions([{field: "from", op: "contains", value: ""}]);
      setMoveTo("");
      setMarkRead(false);
      setMarkStarred(false);
      setMarkImportant(false);
      setAddLabels([]);
      setNotice(`Rule “${d.rule?.name || name.trim()}” created — it runs on new inbound mail.`);
      loadAll();
    } catch {
      setError("Could not create rule.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleRule(rule: RuleRow) {
    const next = !(rule.is_enabled === 1 || rule.is_enabled === true);
    const r = await fetch("/api/filters", {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id: rule.id, is_enabled: next}),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      setError(d?.error || "Could not change the rule.");
      return;
    }
    setNotice(`Rule “${rule.name}” ${next ? "enabled" : "disabled"}.`);
    loadAll();
  }

  async function deleteRule(rule: RuleRow) {
    if (confirmDeleteId !== rule.id) {
      setConfirmDeleteId(rule.id);
      return;
    }
    setConfirmDeleteId("");
    const r = await fetch("/api/filters", {
      method: "DELETE",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id: rule.id}),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      setError(d?.error || "Could not delete the rule.");
      return;
    }
    setNotice(`Rule “${rule.name}” deleted.`);
    loadAll();
  }

  if (!workspace)
    return (
      <section>
        <h2>Mail filters</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>Mail filters</h2>
      <p>
        Rules that run automatically on new inbound mail — move it to a folder, mark it, or add a
        label. A mailbox-scoped rule runs only for that mailbox; “All mailboxes” runs
        workspace-wide. Disabled rules never run. Filters do not touch mail that already arrived.
      </p>
      {error && <p style={{fontSize: 12, color: "#f2a6a6"}}>{error}</p>}
      {notice && <p style={{fontSize: 12, color: "#8fd9b9"}}>{notice}</p>}
      {rules.length === 0 ? (
        <p className="muted">No filters yet — create one below.</p>
      ) : (
        rules.map((rule) => {
          const conds = parseJson(rule.conditions);
          const acts = parseJson(rule.actions);
          const enabled = rule.is_enabled === 1 || rule.is_enabled === true;
          const box = rule.mailbox_id ? boxes.find((b) => b.id === rule.mailbox_id) : null;
          return (
            <article key={rule.id} style={{display: "block"}}>
              <b>{rule.name}</b>
              <span>
                {enabled ? "Enabled" : "Disabled"} · {box ? box.address : "All mailboxes"}
                <br />
                If {describeConditions(conds)}
                <br />
                Then {describeActions(acts)}
              </span>
              <span style={{display: "flex", gap: 8}}>
                <button type="button" onClick={() => toggleRule(rule)}>
                  {enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => deleteRule(rule)}>
                  {confirmDeleteId === rule.id ? "Click again to delete" : "Delete"}
                </button>
              </span>
            </article>
          );
        })
      )}
      <form onSubmit={createRule} style={{display: "block", marginTop: 16}}>
        <label>
          Rule name
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Invoices to Archive" />
        </label>
        <label>
          Mailbox
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            <option value="">All mailboxes</option>
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.address}
              </option>
            ))}
          </select>
        </label>
        <label>
          Match
          <select value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")}>
            <option value="all">All conditions must match</option>
            <option value="any">Any condition may match</option>
          </select>
        </label>
        {conditions.map((c, i) => (
          <div key={i} style={{display: "flex", gap: 8, marginTop: 8}}>
            <select value={c.field} onChange={(e) => setCondition(i, {field: e.target.value})} aria-label="Condition field">
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select value={c.op} onChange={(e) => setCondition(i, {op: e.target.value})} aria-label="Condition operator">
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <input
              value={c.value}
              onChange={(e) => setCondition(i, {value: e.target.value})}
              placeholder={c.field === "has_attachment" ? "true / false" : "value to match"}
              aria-label="Condition value"
            />
            {conditions.length > 1 && (
              <button type="button" onClick={() => setConditions((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove condition">
                ×
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setConditions((xs) => [...xs, {field: "subject", op: "contains", value: ""}])}>
          + Add condition
        </button>
        <label style={{marginTop: 12}}>
          Then do
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">Keep in inbox (no move)</option>
            {FOLDERS.filter((f) => f !== "inbox").map((f) => (
              <option key={f} value={f}>
                Move to {f}
              </option>
            ))}
          </select>
        </label>
        <div style={{display: "flex", gap: 16, marginTop: 8, fontSize: 12}}>
          <label style={{display: "flex", gap: 6, alignItems: "center"}}>
            <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark read
          </label>
          <label style={{display: "flex", gap: 6, alignItems: "center"}}>
            <input type="checkbox" checked={markStarred} onChange={(e) => setMarkStarred(e.target.checked)} /> Star
          </label>
          <label style={{display: "flex", gap: 6, alignItems: "center"}}>
            <input type="checkbox" checked={markImportant} onChange={(e) => setMarkImportant(e.target.checked)} /> Mark important
          </label>
        </div>
        {labels.length > 0 && (
          <label style={{marginTop: 8}}>
            Add labels
            <select
              multiple
              value={addLabels}
              onChange={(e) => setAddLabels(Array.from(e.target.selectedOptions).map((o) => o.value))}
              style={{minHeight: 64}}
            >
              {labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary" disabled={creating} style={{marginTop: 12}}>
          {creating ? "Creating…" : "Create filter"}
        </button>
      </form>
    </section>
  );
}
