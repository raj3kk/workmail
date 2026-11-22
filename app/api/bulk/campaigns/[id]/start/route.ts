// POST /api/bulk/campaigns/[id]/start — start (or resume) a campaign.
//
// Allowed from `draft` (first start) or `paused_caps` (resume after a
// cap window freed, a provider was connected, or the monthly limit
// reset). Resume only processes recipients still `pending` — sent ones
// are never re-sent, failed ones are not retried (their failure was
// terminal for this campaign), and the deterministic per-recipient
// idempotency key makes even a crash-replay safe.
// Guards: one `sending` campaign per workspace at a time, and a
// per-workspace start rate limit (BULK_MAX_STARTS_PER_HOUR).
// The response is the progress summary after the first tick; the UI
// keeps polling GET /api/bulk/campaigns/[id] to drive the rest.
import {NextResponse} from 'next/server';
import {dbOne, dbRun, nowIso} from '@/lib/db';
import {canAccessMailbox, requireUser, workspaceRole} from '@/lib/guards';
import {advanceCampaign, checkBulkStartRateLimit, getBulkCampaignSummary} from '@/lib/bulk';

export const runtime = 'nodejs';

export async function POST(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const campaign = await dbOne('SELECT * FROM bulk_campaigns WHERE id = ?', [params.id]);
  if (!campaign) return NextResponse.json({error: 'Campaign not found.'}, {status: 404});
  const role = await workspaceRole(user.id, String(campaign.workspace_id));
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  if (!(await canAccessMailbox(user.id, String(campaign.mailbox_id), true)))
    return NextResponse.json({error: 'No send permission on this mailbox.'}, {status: 403});
  if (!['draft', 'paused_caps'].includes(String(campaign.status)))
    return NextResponse.json(
      {error: `Campaign cannot be started from status "${campaign.status}".`},
      {status: 409},
    );
  const other = await dbOne(
    "SELECT id FROM bulk_campaigns WHERE workspace_id = ? AND status = 'sending' AND id != ? LIMIT 1",
    [campaign.workspace_id, params.id],
  );
  if (other)
    return NextResponse.json(
      {error: 'Another campaign is already sending in this workspace. Stop it first.'},
      {status: 409},
    );
  const rate = checkBulkStartRateLimit(String(campaign.workspace_id));
  if (!rate.allowed)
    return NextResponse.json(
      {error: `Too many campaign starts. Try again in ${rate.retryAfterSeconds}s.`},
      {status: 429},
    );
  const now = nowIso();
  // Guarded status flip: proceeds ONLY from draft/paused_caps. A 0-change
  // result means another request already started (or stopped) this
  // campaign — report the live status, never assume the flip happened.
  const flipped = await dbRun(
    `UPDATE bulk_campaigns SET status = 'sending', pause_reason = NULL, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('draft', 'paused_caps')`,
    [now, now, params.id],
  );
  if (flipped.changes !== 1) {
    const current = await dbOne('SELECT status FROM bulk_campaigns WHERE id = ?', [params.id]);
    return NextResponse.json(
      {error: `Campaign cannot be started from status "${current?.status ?? 'unknown'}". It may already be sending.`},
      {status: 409},
    );
  }
  const before = await getBulkCampaignSummary(params.id);
  try {
    const summary = await advanceCampaign(params.id);
    return NextResponse.json({campaign: summary});
  } catch (err) {
    // The tick failed. Return the last-known server summary + tick_error
    // (never a guessed state). Non-2xx when the tick processed nothing;
    // 200 when some recipients were decided before the failure, so the
    // UI keeps the confirmed progress and polls on.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bulk start tick]', params.id, message);
    const summary = await getBulkCampaignSummary(params.id);
    const decided = (s: {sent: number; failed: number; skipped: number; unknown: number} | null) =>
      s ? s.sent + s.failed + s.skipped + s.unknown : 0;
    const madeProgress = !!summary && !!before && decided(summary) > decided(before);
    return NextResponse.json(
      {campaign: summary ?? before ?? null, tick_error: message},
      {status: madeProgress ? 200 : 500},
    );
  }
}
