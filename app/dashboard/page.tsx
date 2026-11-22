// Dashboard UI — every number shown here comes from GET /api/dashboard
// (D1). Anything that is an estimate is labelled "estimate" on the page;
// the provider's own counter is the authority for free-limit remaining.
"use client";
import {useCallback, useEffect, useState} from "react";

type CapWindow = {used: number; limit: number | null; remaining: number | null};
type ProviderRow = {
  provider: string;
  configured: boolean;
  enabled: boolean;
  sender_verified: boolean;
  caps: {hourly: number | null; daily: number | null; monthly: number | null};
  cap_state: {
    hourly: CapWindow;
    daily: CapWindow;
    monthly: CapWindow;
    exhausted: boolean;
    exhaustedBy: "hourly" | "daily" | "monthly" | null;
  } | null;
  sent_month_from_delivery_logs: number;
  failed_month_from_delivery_logs: number;
  rejected_attempts_month_from_delivery_logs: number;
  counts_source: string;
  estimate_label: string;
};
type RecentEvent = {
  provider: string;
  event_type: string;
  recipient: string;
  occurred_at: string;
  result: string | null;
  reason: string | null;
};
type DashboardData = {
  workspace_id: string | null;
  period: string;
  totals: {
    sent_all_time: number;
    sent_month: number;
    failed_all_time: number;
    failed_month: number;
    received_month: number;
    received_all_time: number;
    failed_unattributed: number;
    definitions: {sent: string; failed: string; received: string};
  };
  workspace_usage: {sent_count: number; received_count: number; monthly_send_limit: number; period: string};
  providers: ProviderRow[];
  recent_events: RecentEvent[];
  estimate_label: string;
};

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line, #ddd)",
  borderRadius: 10,
  padding: 14,
  minWidth: 0,
};
const tableWrap: React.CSSProperties = {overflowX: "auto", maxWidth: "100%"};
const tableStyle: React.CSSProperties = {width: "100%", fontSize: 13, borderCollapse: "collapse", minWidth: 560};

function fmtWindow(label: string, w: CapWindow | undefined): string {
  if (!w) return "—";
  if (w.limit === null) return `${label}: no cap set`;
  return `${label}: ${w.remaining ?? 0} left of ${w.limit} (used ${w.used})`;
}

export default function DashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      let r: Response;
      try {
        r = await fetch("/api/dashboard", {signal: c.signal});
      } finally {
        clearTimeout(t);
      }
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || `Dashboard request failed (${r.status})`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        setUser(s.user || null);
        if (s.user) load();
        else setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [load]);

  if (loading) return <main className="center">Loading WorkMail…</main>;
  if (!user)
    return (
      <main className="login">
        <div className="loginCard">
          <div className="logo">W</div>
          <h1>Dashboard</h1>
          <p className="muted">Sign in to see your sending dashboard.</p>
          <button
            className="primary wide"
            onClick={() => {
              location.href = "/api/auth/login";
            }}
          >
            Continue with Google
          </button>
        </div>
      </main>
    );

  if (error || !data)
    return (
      <main className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="logo smallLogo">W</span>
            <span>
              <b>WorkMail</b>
              <small>DASHBOARD</small>
            </span>
          </div>
          <button
            className="nav"
            onClick={() => {
              location.href = "/";
            }}
          >
            ← Back to inbox
          </button>
        </aside>
        <section className="content">
          <header className="header">
            <div>
              <div className="eyebrow">WORKSPACE / DASHBOARD</div>
              <h1>Dashboard</h1>
            </div>
          </header>
          <div className="inlineNotice" style={{marginTop: 20}}>
            Could not load dashboard data: {error || "unknown error"}. No numbers are shown because none could be
            verified — this is not a zero. <button onClick={load} style={{marginLeft: 8}}>↻ Retry</button>
          </div>
        </section>
      </main>
    );

  const t = data.totals;
  const u = data.workspace_usage;
  const pct = u.monthly_send_limit > 0 ? Math.min(100, Math.round((u.sent_count / u.monthly_send_limit) * 100)) : 0;
  const noSendsYet = t.sent_all_time === 0 && t.failed_all_time === 0;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo smallLogo">W</span>
          <span>
            <b>WorkMail</b>
            <small>DASHBOARD</small>
          </span>
        </div>
        <button
          className="nav"
          onClick={() => {
            location.href = "/";
          }}
        >
          ← Back to inbox
        </button>
        <button
          className="nav"
          onClick={() => {
            location.href = "/bulk";
          }}
        >
          ⇪ Bulk send
        </button>
        <div className="account">
          <div className="avatar">{(user.email || "W")[0].toUpperCase()}</div>
          <div>
            <b>{user.email}</b>
            <small>Signed in</small>
          </div>
        </div>
      </aside>
      <section className="content">
        <header className="header">
          <div>
            <div className="eyebrow">WORKSPACE / DASHBOARD</div>
            <h1>Dashboard</h1>
          </div>
          <button onClick={load}>↻ Refresh</button>
        </header>

        <div style={{display: "grid", gap: 16, maxWidth: 860, marginTop: 20}}>
          {noSendsYet && (
            <div className="inlineNotice">
              No sends yet — everything below shows 0 until your first send is accepted by a provider. Zeros here
              mean “nothing recorded in D1”, not an error.
            </div>
          )}

          <section>
            <h2>Totals</h2>
            <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12}}>
              <div style={cardStyle}>
                <small className="muted">Sent this month</small>
                <div style={{fontSize: 28, fontWeight: 800}}>{t.sent_month}</div>
              </div>
              <div style={cardStyle}>
                <small className="muted">Sent all-time</small>
                <div style={{fontSize: 28, fontWeight: 800}}>{t.sent_all_time}</div>
              </div>
              <div style={cardStyle}>
                <small className="muted">Failed this month</small>
                <div style={{fontSize: 28, fontWeight: 800}}>{t.failed_month}</div>
                <small className="muted">all-time: {t.failed_all_time}</small>
              </div>
              <div style={cardStyle}>
                <small className="muted">Received this month</small>
                <div style={{fontSize: 28, fontWeight: 800}}>{t.received_month}</div>
                <small className="muted">all-time: {t.received_all_time}</small>
              </div>
            </div>
          </section>

          <section>
            <h2>Monthly usage — {u.period}</h2>
            <p>
              <b>
                {u.sent_count} / {u.monthly_send_limit}
              </b>{" "}
              sends used this month · {u.received_count} received
            </p>
            <div style={{height: 10, background: "#eee", borderRadius: 5, overflow: "hidden"}}>
              <div style={{width: `${pct}%`, height: "100%", background: "#2563eb"}} />
            </div>
            <small className="muted">
              {pct}% of your workspace monthly send limit. Counted from usage_counters for period {u.period}.
            </small>
          </section>

          <section>
            <h2>Providers</h2>
            {data.providers.length === 0 && (
              <p className="muted">No workspace found for your account yet — provider status will appear once a workspace exists.</p>
            )}
            {data.providers.length > 0 && (
              <div style={tableWrap}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th align="left">Provider</th>
                      <th align="left">Status</th>
                      <th align="left">Sender</th>
                      <th align="left">Sent (month)</th>
                      <th align="left">Failed (month)</th>
                      <th align="left">Attempts rejected (month)</th>
                      <th align="left">Free-limit remaining (estimate)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((p) => (
                      <tr key={p.provider}>
                        <td>
                          <b>{p.provider}</b>
                          {!p.configured && <div><small className="muted">not configured</small></div>}
                        </td>
                        <td>{p.enabled ? "Enabled" : "Disabled"}</td>
                        <td>{p.sender_verified ? "Verified" : "Not verified"}</td>
                        <td>{p.sent_month_from_delivery_logs}</td>
                        <td>{p.failed_month_from_delivery_logs}</td>
                        <td>{p.rejected_attempts_month_from_delivery_logs}</td>
                        <td>
                          {p.cap_state ? (
                            <>
                              <div>{fmtWindow("Hour", p.cap_state.hourly)}</div>
                              <div>{fmtWindow("Day", p.cap_state.daily)}</div>
                              <div>{fmtWindow("Month", p.cap_state.monthly)}</div>
                              <div>
                                <small className="muted">estimate — {p.estimate_label}</small>
                              </div>
                              {p.cap_state.exhausted && (
                                <div style={{color: "#f2a6a6"}}>
                                  <b>Capped:</b> {p.cap_state.exhaustedBy} limit reached — sends to this provider are
                                  paused until the window resets.
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="muted">Cap state unavailable (D1 read failed) — no estimate shown.</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <small className="muted">
              Sent/failed per provider are from delivery logs (delivery_events, current month) and use the same
              definition as Totals: failed means the send was never accepted by any provider, attributed to the last
              provider attempted for that send — so the per-provider Failed figures sum to Totals Failed
              {t.failed_unattributed > 0 &&
                ` (plus ${t.failed_unattributed} failed send${t.failed_unattributed === 1 ? "" : "s"} with no recorded rejection, counted in Totals only)`}
              . “Attempts rejected” counts individual provider rejections: a send rejected by one provider but
              accepted by the next in the chain counts here, not as a failed send. Free-limit remaining is an
              estimate from D1 accepted sends — the provider’s own counter is the authority.
            </small>
          </section>

          <section>
            <h2>Recent delivery events</h2>
            {data.recent_events.length === 0 && (
              <p className="muted">No delivery events recorded yet.</p>
            )}
            {data.recent_events.length > 0 && (
              <div style={tableWrap}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th align="left">When (UTC)</th>
                      <th align="left">Provider</th>
                      <th align="left">Event</th>
                      <th align="left">Recipient</th>
                      <th align="left">Result / reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_events.map((e, i) => (
                      <tr key={`${e.occurred_at}-${e.provider}-${i}`}>
                        <td>{e.occurred_at ? e.occurred_at.replace("T", " ").slice(0, 19) : "—"}</td>
                        <td>{e.provider}</td>
                        <td>{e.event_type}</td>
                        <td style={{overflowWrap: "anywhere"}}>{e.recipient || "—"}</td>
                        <td>{[e.result, e.reason].filter(Boolean).join(" — ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2>How these numbers are counted</h2>
            <ul style={{fontSize: 13, lineHeight: 1.7, color: "var(--muted, #8899aa)"}}>
              <li>
                <b>Sent:</b> {t.definitions.sent}
              </li>
              <li>
                <b>Failed:</b> {t.definitions.failed}
              </li>
              <li>
                <b>Received:</b> {t.definitions.received}
              </li>
              <li>
                <b>Per-provider sent/failed:</b> counted from delivery_events rows for the current month. Sent =
                ‘accepted’ events (one per send — the provider that took it). Failed = the same definition as
                Totals Failed (sends never accepted by any provider), attributed to the last provider attempted for
                each send, so the per-provider Failed figures sum to Totals Failed. “Attempts rejected” = individual
                ‘rejected’ events: a send rejected by one provider but accepted by the next counts there, not as a
                failed send.
              </li>
              <li>
                <b>Free-limit remaining:</b> {data.estimate_label}. Caps enforced in code: SendPulse 12,000/month +
                50/hour, Brevo 300/day, Mailjet 6,000/month + 200/day, Resend 3,000/month + 100/day.
              </li>
              <li>
                <b>Monthly usage:</b> usage_counters row for period {u.period}, against workspace_settings
                monthly_send_limit.
              </li>
              <li>All figures are read from D1 for your workspace only. Nothing here is guessed or assumed.</li>
            </ul>
          </section>
        </div>
      </section>
    </main>
  );
}
