// Dashboard API — every number comes from D1 (RULE 0).
// - "sent" counts messages the provider accepted: folder='sent' AND
//   delivery_state IN ('accepted','sent','delivered','opened','clicked','deferred').
// - "failed" counts idempotency_keys with status='failed' (a send the
//   provider definitely rejected, or that failed after the chain ran).
// - "received" is usage_counters.received_count for the current period.
// - Per-provider sent/failed come from delivery_events (labelled "from
//   delivery logs").
// - Cap "remaining" figures are estimates from D1 accepted sends — the
//   provider's own counter is the authority. Caps come from PROVIDER_CAPS
//   (SendPulse 12,000/month SMTP cap, not the marketing-page figure).
// Never returns secrets.
import {NextResponse} from 'next/server';
import {dbOne, dbQuery, jparse} from '@/lib/db';
import {requireUser, listWorkspaceIds} from '@/lib/guards';
import {PROVIDER_CHAIN, PROVIDER_CAPS, getCapState, type ProviderName} from '@/lib/providers';

export const runtime = 'nodejs';

const SENT_STATES = "('accepted','sent','delivered','opened','clicked','deferred')";

const ESTIMATE_LABEL =
  'estimate from D1 accepted sends — the provider\u2019s own counter is the authority';

function monthParts(now: Date): {period: string; monthKey: string} {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return {period: `${y}-${m}-01`, monthKey: `${y}-${m}`};
}

async function countOne(sql: string, params: unknown[]): Promise<number> {
  const row = await dbOne(sql, params);
  return Number(row?.n || 0);
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const ids = await listWorkspaceIds(user.id);
  const {period, monthKey} = monthParts(new Date());

  // No workspace yet: honest empty dashboard (zeros, not an error).
  if (!ids.length) {
    return NextResponse.json({
      workspace_id: null,
      period,
      totals: {
        sent_all_time: 0,
        sent_month: 0,
        failed_all_time: 0,
        failed_month: 0,
        received_month: 0,
        definitions: {
          sent: "Messages with folder='sent' and delivery_state in accepted/sent/delivered/opened/clicked/deferred — i.e. the provider accepted the send.",
          failed: "Idempotency keys with status='failed' — a send the provider definitely rejected (or that failed after the fallback chain ran).",
          received: 'usage_counters.received_count for the current period (inbound mail received).',
        },
      },
      workspace_usage: {sent_count: 0, received_count: 0, monthly_send_limit: 300, period},
      providers: [],
      recent_events: [],
      estimate_label: ESTIMATE_LABEL,
    });
  }

  const workspaceId = String(ids[0]);
  try {
    const [sentAllTime, sentMonth, failedAllTime, failedMonth] = await Promise.all([
      countOne(
        `SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND folder = 'sent' AND delivery_state IN ${SENT_STATES}`,
        [workspaceId],
      ),
      countOne(
        `SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND folder = 'sent' AND delivery_state IN ${SENT_STATES} AND substr(created_at, 1, 7) = ?`,
        [workspaceId, monthKey],
      ),
      countOne(`SELECT COUNT(*) AS n FROM idempotency_keys WHERE workspace_id = ? AND status = 'failed'`, [
        workspaceId,
      ]),
      countOne(
        `SELECT COUNT(*) AS n FROM idempotency_keys WHERE workspace_id = ? AND status = 'failed' AND substr(created_at, 1, 7) = ?`,
        [workspaceId, monthKey],
      ),
    ]);

    const usageRow = await dbOne(
      'SELECT sent_count, received_count FROM usage_counters WHERE workspace_id = ? AND period_start = ?',
      [workspaceId, period],
    );
    const settingsRow = await dbOne(
      'SELECT monthly_send_limit FROM workspace_settings WHERE workspace_id = ?',
      [workspaceId],
    );
    const monthlySendLimit = Number(settingsRow?.monthly_send_limit ?? 300);

    const secretRows = await dbQuery(
      'SELECT provider, enabled, sender_verified FROM provider_secrets WHERE workspace_id = ?',
      [workspaceId],
    );
    const secretByProvider = new Map<string, {enabled: number; sender_verified: number}>();
    for (const r of secretRows || []) {
      secretByProvider.set(String(r.provider), {
        enabled: Number(r.enabled),
        sender_verified: Number(r.sender_verified),
      });
    }

    // Per-provider sent/failed from delivery logs (current month only).
    const logRows = await dbQuery(
      `SELECT provider, event_type, COUNT(*) AS n FROM delivery_events
       WHERE workspace_id = ? AND substr(occurred_at, 1, 7) = ? AND event_type IN ('accepted', 'rejected')
       GROUP BY provider, event_type`,
      [workspaceId, monthKey],
    );
    const logCounts = new Map<string, {sent: number; failed: number}>();
    for (const r of logRows || []) {
      const key = String(r.provider);
      const cur = logCounts.get(key) || {sent: 0, failed: 0};
      if (r.event_type === 'accepted') cur.sent = Number(r.n || 0);
      if (r.event_type === 'rejected') cur.failed = Number(r.n || 0);
      logCounts.set(key, cur);
    }

    const providers = [];
    for (const provider of PROVIDER_CHAIN) {
      const secret = secretByProvider.get(provider);
      let capState = null;
      try {
        capState = await getCapState(workspaceId, provider as ProviderName);
      } catch {
        capState = null;
      }
      const logs = logCounts.get(provider) || {sent: 0, failed: 0};
      providers.push({
        provider,
        configured: !!secret,
        enabled: secret ? secret.enabled === 1 : false,
        sender_verified: secret ? secret.sender_verified === 1 : false,
        caps: PROVIDER_CAPS[provider as ProviderName],
        cap_state: capState,
        // Counts from delivery logs (current month). 'accepted' events are
        // recorded per provider attempt; 'rejected' likewise.
        sent_month_from_delivery_logs: logs.sent,
        failed_month_from_delivery_logs: logs.failed,
        counts_source: 'delivery_events (current month)',
        estimate_label: ESTIMATE_LABEL,
      });
    }

    const eventRows = await dbQuery(
      `SELECT provider, event_type, recipient, occurred_at, details FROM delivery_events
       WHERE workspace_id = ? ORDER BY occurred_at DESC LIMIT 20`,
      [workspaceId],
    );
    const recentEvents = (eventRows || []).map((r: any) => {
      const details = jparse<Record<string, any>>(r.details, {});
      return {
        provider: r.provider,
        event_type: r.event_type,
        recipient: r.recipient || '',
        occurred_at: r.occurred_at,
        result: details.result ?? null,
        reason: details.reason ?? null,
      };
    });

    return NextResponse.json({
      workspace_id: workspaceId,
      period,
      totals: {
        sent_all_time: sentAllTime,
        sent_month: sentMonth,
        failed_all_time: failedAllTime,
        failed_month: failedMonth,
        received_month: Number(usageRow?.received_count || 0),
        definitions: {
          sent: "Messages with folder='sent' and delivery_state in accepted/sent/delivered/opened/clicked/deferred — i.e. the provider accepted the send.",
          failed: "Idempotency keys with status='failed' — a send the provider definitely rejected (or that failed after the fallback chain ran).",
          received: 'usage_counters.received_count for the current period (inbound mail received).',
        },
      },
      workspace_usage: {
        sent_count: Number(usageRow?.sent_count || 0),
        received_count: Number(usageRow?.received_count || 0),
        monthly_send_limit: monthlySendLimit,
        period,
      },
      providers,
      recent_events: recentEvents,
      estimate_label: ESTIMATE_LABEL,
    });
  } catch (e) {
    return NextResponse.json(
      {error: e instanceof Error ? e.message : 'Could not load dashboard data'},
      {status: 500},
    );
  }
}
