// WorkMail mail filters / rules engine (Gmail parity).
//
// Rules live in the `mail_rules` D1 table (workspace- or mailbox-scoped,
// JSON `conditions` + `actions`, `is_enabled` flag). This module is the
// ONLY reader/evaluator: the inbound route calls `applyMailRules` once
// per accepted message (best-effort — it never throws), and
// /api/filters is the CRUD surface for the Settings UI.
//
// Conditions JSON:
//   { "match": "all" | "any",                       // default "all"
//     "rules": [{ "field": "from"|"to"|"subject"|"body"|"has_attachment",
//                 "op": "contains"|"equals"|"starts_with"|"ends_with",
//                 "value": "string" }] }
//   `has_attachment` uses op "is" with value "true"/"false".
//   Field matching is case-insensitive; "body" matches text_body (and,
//   when present, a tag-stripped html_body).
//
// Actions JSON (unknown keys are ignored, so new actions stay
// forward-compatible):
//   { "move_to_folder": "archive"|"trash"|"spam"|"inbox",
//     "mark_read": true,
//     "mark_starred": true,
//     "mark_important": true,   // needs the is_important migration
//     "add_labels": ["<label-id>", ...] }
// All matching enabled rules run, in created_at order; a later rule's
// move_to_folder wins over an earlier one.
import {dbQuery, dbRun, jparse} from '@/lib/db';

export const FILTER_FOLDERS = ['inbox', 'archive', 'trash', 'spam'] as const;

export interface FilterCondition {
  field: 'from' | 'to' | 'subject' | 'body' | 'has_attachment';
  op: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'is';
  value: string;
}

export interface FilterConditions {
  match?: 'all' | 'any';
  rules?: FilterCondition[];
}

export interface FilterActions {
  move_to_folder?: string;
  mark_read?: boolean;
  mark_starred?: boolean;
  mark_important?: boolean;
  add_labels?: string[];
}

export interface InboundMessageForRules {
  workspaceId: string;
  mailboxId: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
}

export interface RuleApplication {
  ruleId: string;
  ruleName: string;
  actions: FilterActions;
}

function haystack(field: string, msg: InboundMessageForRules, hasAttachment: boolean): string {
  switch (field) {
    case 'from':
      return msg.from;
    case 'to':
      return msg.to;
    case 'subject':
      return msg.subject;
    case 'body': {
      const htmlText = msg.htmlBody ? msg.htmlBody.replace(/<[^>]*>/g, ' ') : '';
      return `${msg.textBody}\n${htmlText}`;
    }
    case 'has_attachment':
      return hasAttachment ? 'true' : 'false';
    default:
      return '';
  }
}

function conditionMatches(c: FilterCondition, msg: InboundMessageForRules, hasAttachment: boolean): boolean {
  const hay = haystack(c.field, msg, hasAttachment).toLowerCase();
  const needle = String(c.value || '').toLowerCase();
  switch (c.op) {
    case 'contains':
      return needle.length > 0 && hay.includes(needle);
    case 'equals':
      return hay.trim() === needle.trim();
    case 'starts_with':
      return needle.length > 0 && hay.trim().startsWith(needle);
    case 'ends_with':
      return needle.length > 0 && hay.trim().endsWith(needle);
    case 'is':
      return hay.trim() === needle.trim();
    default:
      return false;
  }
}

export function ruleMatches(conditions: FilterConditions | null, msg: InboundMessageForRules, hasAttachment: boolean): boolean {
  const rules = Array.isArray(conditions?.rules) ? conditions!.rules! : [];
  if (rules.length === 0) return false;
  const match = conditions?.match === 'any' ? 'any' : 'all';
  return match === 'any'
    ? rules.some((c) => conditionMatches(c, msg, hasAttachment))
    : rules.every((c) => conditionMatches(c, msg, hasAttachment));
}

function parseActions(raw: string | null): FilterActions {
  const a = jparse<FilterActions>(raw, {});
  if (typeof a !== 'object' || a === null) return {};
  return {
    move_to_folder:
      typeof a.move_to_folder === 'string' && (FILTER_FOLDERS as readonly string[]).includes(a.move_to_folder)
        ? a.move_to_folder
        : undefined,
    mark_read: a.mark_read === true,
    mark_starred: a.mark_starred === true,
    mark_important: a.mark_important === true,
    add_labels: Array.isArray(a.add_labels) ? a.add_labels.filter((x) => typeof x === 'string') : undefined,
  };
}

/**
 * Evaluate every enabled rule for this mailbox (mailbox-scoped rules
 * first, then workspace-wide rules) against an inbound message and
 * apply the actions of each matching rule. Never throws: a rule that
 * fails to apply (e.g. the is_important column is not migrated yet)
 * is skipped and the rest still run, so inbound delivery is never
 * blocked by a filter error.
 */
export async function applyMailRules(msg: InboundMessageForRules): Promise<RuleApplication[]> {
  const applied: RuleApplication[] = [];
  let rules: Array<{id: string; name: string; conditions: string; actions: string}>;
  try {
    rules = (await dbQuery(
      `SELECT id, name, conditions, actions FROM mail_rules
        WHERE workspace_id = ? AND is_enabled = 1
          AND (mailbox_id = ? OR mailbox_id IS NULL)
        ORDER BY created_at ASC`,
      [msg.workspaceId, msg.mailboxId],
    )) as typeof rules;
  } catch {
    return applied; // Rules table unreadable — deliver the message unfiltered.
  }
  if (rules.length === 0) return applied;
  let hasAttachment = false;
  try {
    const row = await dbQuery('SELECT COUNT(*) AS c FROM message_attachments WHERE message_id = ?', [msg.messageId]);
    hasAttachment = Number(row[0]?.c || 0) > 0;
  } catch {
    hasAttachment = false;
  }
  for (const rule of rules) {
    let conditions: FilterConditions | null = null;
    try {
      conditions = jparse<FilterConditions | null>(rule.conditions, null);
    } catch {
      continue; // Malformed conditions — skip the rule, never block mail.
    }
    if (!ruleMatches(conditions, msg, hasAttachment)) continue;
    const actions = parseActions(rule.actions);
    try {
      await applyActions(msg, actions);
    } catch {
      continue; // One rule's failure must not stop later rules.
    }
    applied.push({ruleId: String(rule.id), ruleName: String(rule.name), actions});
  }
  return applied;
}

async function applyActions(msg: InboundMessageForRules, actions: FilterActions): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (actions.move_to_folder) {
    sets.push('folder = ?');
    values.push(actions.move_to_folder);
  }
  if (actions.mark_read) {
    sets.push('is_read = 1');
  }
  if (actions.mark_starred) {
    sets.push('is_starred = 1');
  }
  if (actions.mark_important) {
    sets.push('is_important = 1');
  }
  if (sets.length > 0) {
    values.push(msg.messageId);
    await dbRun(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, values);
  }
  if (actions.add_labels && actions.add_labels.length > 0) {
    // Only labels that belong to this workspace may be attached.
    const placeholders = actions.add_labels.map(() => '?').join(',');
    const owned = await dbQuery(
      `SELECT id FROM labels WHERE workspace_id = ? AND id IN (${placeholders})`,
      [msg.workspaceId, ...actions.add_labels],
    );
    for (const row of owned) {
      await dbRun('INSERT OR IGNORE INTO message_labels (message_id, label_id, created_at) VALUES (?, ?, datetime(\'now\'))', [
        msg.messageId,
        String(row.id),
      ]).catch(() => {});
    }
  }
}

/** Validate a conditions/actions pair from an API caller. Returns an error string or null. */
export function validateRuleInput(
  conditions: unknown,
  actions: unknown,
): string | null {
  if (typeof conditions !== 'object' || conditions === null) return 'conditions must be an object';
  const c = conditions as FilterConditions;
  if (!Array.isArray(c.rules) || c.rules.length === 0) return 'conditions.rules must be a non-empty array';
  if (c.rules.length > 10) return 'at most 10 conditions per rule';
  const fields = ['from', 'to', 'subject', 'body', 'has_attachment'];
  const ops = ['contains', 'equals', 'starts_with', 'ends_with', 'is'];
  for (const r of c.rules) {
    if (!fields.includes(r.field)) return `unknown condition field: ${String(r.field)}`;
    if (!ops.includes(r.op)) return `unknown condition op: ${String(r.op)}`;
    if (typeof r.value !== 'string' || r.value.length > 500) return 'condition value must be a string up to 500 chars';
  }
  if (c.match !== undefined && c.match !== 'all' && c.match !== 'any') return 'conditions.match must be "all" or "any"';
  if (typeof actions !== 'object' || actions === null) return 'actions must be an object';
  const a = actions as FilterActions;
  const hasAction =
    (typeof a.move_to_folder === 'string' && FILTER_FOLDERS.includes(a.move_to_folder as (typeof FILTER_FOLDERS)[number])) ||
    a.mark_read === true ||
    a.mark_starred === true ||
    a.mark_important === true ||
    (Array.isArray(a.add_labels) && a.add_labels.length > 0);
  if (!hasAction) return 'actions must include at least one supported action';
  if (Array.isArray(a.add_labels) && a.add_labels.length > 10) return 'at most 10 labels per rule';
  return null;
}
