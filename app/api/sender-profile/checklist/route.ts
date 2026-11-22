import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {canAccessMailbox, isValidOrigin, requireUser} from '@/lib/guards';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

// Sender profile — user-confirmed Google alternate-email checklist (S1, §15.1).
// GET  /api/sender-profile/checklist?mailbox_id=<id>
// POST /api/sender-profile/checklist  {mailbox_id, step_key, done}
//
// RULE 0: a step is done ONLY when the user ticks it. There is NO Google
// API for adding an alternate email to a personal Google Account, so the
// app cannot see the user's Google Account and NOTHING is auto-checked,
// auto-verified, or inferred. Ticking a step stores one row in
// sender_profile_steps (migration 0009); unticking deletes it.
//
// STEP_KEYS must match the WIZARD_STEPS list in
// app/settings/SenderProfileSection.tsx and the step_key comment in
// db/migrations/0009_sender_profile.sql.

const STEP_KEYS = [
  'open_google_account',
  'personal_info',
  'email_section',
  'alternate_emails',
  'add_address',
  'find_verification_mail',
  'click_verify_link',
  'approve_phone_prompt',
] as const;

function missingTable(e: unknown): boolean {
  return e instanceof Error && /no such table/i.test(e.message);
}

async function loadSteps(workspaceId: string, mailboxId: string) {
  const rows = await dbQuery(
    'SELECT step_key, done_at FROM sender_profile_steps WHERE workspace_id = ? AND mailbox_id = ? ORDER BY done_at ASC',
    [workspaceId, mailboxId],
  );
  return rows.map((r) => ({step_key: String(r.step_key), done_at: String(r.done_at)}));
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const mailboxId = new URL(req.url).searchParams.get('mailbox_id') || '';
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailboxId)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  const box = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ?', [mailboxId]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  try {
    const steps = await loadSteps(String(box.workspace_id), mailboxId);
    return NextResponse.json({
      mailbox_id: mailboxId,
      steps,
      done_count: steps.length,
      total: STEP_KEYS.length,
    });
  } catch (e) {
    if (missingTable(e))
      return NextResponse.json(
        {error: 'Sender profile checklist is not set up yet — migration 0009 has not been applied.'},
        {status: 503},
      );
    throw e;
  }
}

export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const limited = await withRateLimit({
    scope: 'write',
    subject: user.id,
    limit: RATE_LIMIT_DEFAULTS.write.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.write.windowSeconds,
  });
  if (limited) return limited;
  const b = await req.json().catch(() => null);
  const mailboxId = String(b?.mailbox_id || '');
  const stepKey = String(b?.step_key || '');
  const done = b?.done === true;
  if (!mailboxId || !(STEP_KEYS as readonly string[]).includes(stepKey))
    return NextResponse.json({error: 'Valid mailbox_id and step_key required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailboxId, true)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  const box = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ?', [mailboxId]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  const workspaceId = String(box.workspace_id);
  try {
    if (done) {
      const now = nowIso();
      await dbRun(
        `INSERT INTO sender_profile_steps (id, workspace_id, mailbox_id, step_key, done_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, mailbox_id, step_key) DO UPDATE SET done_at = excluded.done_at`,
        [newId(), workspaceId, mailboxId, stepKey, now, now],
      );
    } else {
      await dbRun(
        'DELETE FROM sender_profile_steps WHERE workspace_id = ? AND mailbox_id = ? AND step_key = ?',
        [workspaceId, mailboxId, stepKey],
      );
    }
    const steps = await loadSteps(workspaceId, mailboxId);
    return NextResponse.json({
      mailbox_id: mailboxId,
      steps,
      done_count: steps.length,
      total: STEP_KEYS.length,
    });
  } catch (e) {
    if (missingTable(e))
      return NextResponse.json(
        {error: 'Sender profile checklist is not set up yet — migration 0009 has not been applied.'},
        {status: 503},
      );
    throw e;
  }
}
