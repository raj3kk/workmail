// GET /api/bulk/campaigns/[id] — campaign status + per-recipient progress.
//
// This is the live status endpoint the Bulk UI polls every 2s while a
// campaign is sending. Polling is also what DRIVES the campaign: when
// the campaign is `sending`, each GET advances it by one tick
// (BULK_TICK_SIZE recipients via lib/bulk.ts `advanceCampaign`) before
// responding, because Vercel functions have no background worker to run
// a long campaign in. If polling stops, sending pauses where it is —
// nothing is lost; the next poll (or a resume) picks up the pending
// recipients. Query params: limit (default 50, max 200), offset,
// status (pending|sent|failed|skipped|unknown) to page the recipients.
import {NextResponse} from 'next/server';
import {dbOne, dbQuery} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {advanceCampaign, getBulkCampaignSummary} from '@/lib/bulk';

export const runtime = 'nodejs';

async function loadCampaign(req: Request, id: string) {
  const {user, response} = await requireUser(req);
  if (response) return {error: response};
  if (!user) return {error: NextResponse.json({error: 'Unauthorized'}, {status: 401})};
  const campaign = await dbOne('SELECT * FROM bulk_campaigns WHERE id = ?', [id]);
  if (!campaign) return {error: NextResponse.json({error: 'Campaign not found.'}, {status: 404})};
  const role = await workspaceRole(user.id, String(campaign.workspace_id));
  // P-02: 404 (not 403) on denial, so a cross-tenant campaign-id probe
  // cannot confirm another tenant's campaign exists by the status code.
  if (!role) return {error: NextResponse.json({error: 'Campaign not found.'}, {status: 404})};
  return {user, campaign};
}

export async function GET(req: Request, {params}: {params: {id: string}}) {
  const loaded = await loadCampaign(req, params.id);
  if (loaded.error) return loaded.error;
  const campaign = loaded.campaign!;

  // Tick-on-poll: a `sending` campaign advances one batch per status
  // poll. See lib/bulk.ts header for the model. A tick failure is
  // logged server-side and reported as `tick_error` — never swallowed:
  // the response still carries the last-known server summary, and the
  // UI must show the status as unknown rather than assume progress.
  let tickError: string | null = null;
  if (campaign.status === 'sending') {
    try {
      await advanceCampaign(params.id);
    } catch (err) {
      // P-04: the raw tick error can carry D1/Cloudflare internals
      // (lib/db.ts) — it stays in the server log (console.error below)
      // and the client gets only the controlled message. 'Campaign not
      // found.' is the one safe tick error advanceCampaign throws.
      const raw = err instanceof Error ? err.message : String(err);
      tickError = raw === 'Campaign not found.' ? raw : 'Campaign tick failed. Check the server logs and retry.';
      console.error('[bulk tick]', params.id, raw);
    }
  }
  const summary = await getBulkCampaignSummary(params.id);
  if (!summary) return NextResponse.json({error: 'Campaign not found.'}, {status: 404});

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const statusFilter = url.searchParams.get('status') || '';
  const where =
    "campaign_id = ?" + (['pending', 'sent', 'failed', 'skipped', 'unknown'].includes(statusFilter) ? ' AND status = ?' : '');
  const args: unknown[] = [params.id];
  if (statusFilter && where.includes('status = ?')) args.push(statusFilter);
  const recipients = await dbQuery(
    `SELECT id, email, name, status, provider, provider_message_id, error, attempts, sent_at, created_at
     FROM bulk_recipients WHERE ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  return NextResponse.json({campaign: summary, recipients, tick_error: tickError});
}
