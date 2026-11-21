// POST /api/bulk/campaigns/[id]/stop — halt a sending (or paused) campaign.
//
// The runner re-reads the campaign row before every recipient, so the
// stop takes effect promptly (at most one in-flight send finishes).
// Already-sent recipients stay `sent`; every other recipient stays
// `pending` and is never touched by the stop. A stopped campaign is
// terminal — it cannot be resumed (create a new campaign to re-send to
// the pending recipients); only `paused_caps` campaigns resume via
// /start.
import {NextResponse} from 'next/server';
import {dbOne, dbRun, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {getBulkCampaignSummary} from '@/lib/bulk';

export const runtime = 'nodejs';

export async function POST(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const campaign = await dbOne('SELECT * FROM bulk_campaigns WHERE id = ?', [params.id]);
  if (!campaign) return NextResponse.json({error: 'Campaign not found.'}, {status: 404});
  const role = await workspaceRole(user.id, String(campaign.workspace_id));
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  if (!['sending', 'paused_caps'].includes(String(campaign.status)))
    return NextResponse.json(
      {error: `Campaign cannot be stopped from status "${campaign.status}".`},
      {status: 409},
    );
  const now = nowIso();
  await dbRun(
    `UPDATE bulk_campaigns SET status = 'stopped', finished_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, params.id],
  );
  const summary = await getBulkCampaignSummary(params.id);
  return NextResponse.json({campaign: summary});
}
