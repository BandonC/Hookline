import Link from "next/link";
import {
  listEndpoints,
  recentEvents,
  eventCounts,
  pendingEvents,
  latestDeadLetterAt,
} from "@/lib/queries";
import { fmtDuration, fmtTime } from "@/lib/format";
import {
  classifyPending,
  describeEndpoint,
  describeEvent,
  summarize,
  type WaitKind,
} from "@/lib/narrate";
import { AttemptPips } from "./components/AttemptPips";
import { DeliveryLine } from "./components/DeliveryLine";
import { LiveRefresh } from "./components/LiveRefresh";
import { StatusBadge } from "./components/StatusBadge";
import styles from "./components/ui.module.css";

export const dynamic = "force-dynamic";

const rowTint: Partial<Record<string, string>> = {
  failed: styles.rowFailed,
  pending: styles.rowPending,
};

export default async function Home() {
  const [endpoints, evts, counts, pending, lastDeadLetter] = await Promise.all([
    listEndpoints(),
    recentEvents(),
    eventCounts(),
    pendingEvents(),
    latestDeadLetterAt(),
  ]);

  const now = Date.now();
  const waiting: Record<WaitKind, number> = {
    late: 0,
    retrying: 0,
    breaker: 0,
    throttled: 0,
    tenant: 0,
    turn: 0,
    queued: 0,
  };
  for (const e of pending) waiting[classifyPending(e, now)] += 1;
  const summary = summarize({ endpoints, waiting, counts, lastDeadLetterAt: lastDeadLetter, now });

  return (
    <>
      <section className={styles.hero} data-tone={summary.tone}>
        <div className={styles.heroTop}>
          <h1 className={styles.eyebrow}>Right now</h1>
          <LiveRefresh renderedAt={now} />
        </div>
        <p className={styles.headline}>{summary.headline}</p>
        {summary.items.length > 0 ? (
          <ul className={styles.heroItems}>
            {summary.items.map((item) => (
              <li key={item.text} data-tone={item.tone}>
                {item.href ? <Link href={item.href}>{item.text}</Link> : item.text}
              </li>
            ))}
          </ul>
        ) : null}
        <DeliveryLine counts={counts} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>Endpoints</h2>
          <span className={styles.count}>{endpoints.length} total</span>
        </div>
        {endpoints.length === 0 ? (
          <p className={styles.empty}>No endpoints registered.</p>
        ) : (
          <div className={styles.endpointGrid}>
            {endpoints.map((e) => {
              const story = describeEndpoint(e, now);
              const total = e.pending + e.delivered + e.failed;
              return (
                <article key={e.id} className={styles.endpoint} data-tone={story.tone}>
                  <div className={styles.endpointHead}>
                    <h3>{e.description ?? e.id}</h3>
                    <StatusBadge tone={story.tone} label={story.label} />
                  </div>
                  <p className={styles.endpointStory}>{story.detail}</p>
                  {total > 0 ? (
                    <div
                      className={styles.meter}
                      role="img"
                      aria-label={`${e.delivered} delivered, ${e.pending} waiting, ${e.failed} dead-lettered`}
                      title={`${e.delivered} delivered · ${e.pending} waiting · ${e.failed} dead-lettered`}
                    >
                      <span data-tone="ok" style={{ flexGrow: e.delivered }} />
                      <span data-tone="wait" style={{ flexGrow: e.pending }} />
                      <span data-tone="bad" style={{ flexGrow: e.failed }} />
                    </div>
                  ) : null}
                  <p className={`${styles.mono} ${styles.endpointUrl}`} title={e.url}>
                    {e.url}
                  </p>
                  <div className={styles.tags}>
                    <span className={styles.tag} title="Endpoint ID">{e.id}</span>
                    <span className={styles.tag} title="Tenant">{e.tenantId}</span>
                    {e.ordered ? <span className={styles.tag}>ordered</span> : null}
                    {e.rateLimitRps !== null && e.rateLimitBurst !== null ? (
                      <span className={styles.tag}>
                        {e.rateLimitRps}/s, burst {e.rateLimitBurst}
                      </span>
                    ) : null}
                    {e.circuitBreakerEnabled ? <span className={styles.tag}>breaker on</span> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>Recent deliveries</h2>
          <span className={styles.count}>Latest {evts.length}</span>
        </div>
        {evts.length === 0 ? (
          <p className={styles.empty}>No events yet.</p>
        ) : (
          <div className={styles.card}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Recent deliveries</caption>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>What happened</th>
                    <th>Attempts</th>
                    <th>Endpoint</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {evts.map((e) => {
                    const story = describeEvent(e, now);
                    return (
                      <tr key={e.id} className={rowTint[e.status]}>
                        <td>
                          <Link
                            className={`${styles.mono} ${styles.truncate}`}
                            title={e.id}
                            href={`/events/${e.id}`}
                          >
                            {e.id}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge tone={story.tone} label={story.label} />
                        </td>
                        <td className={styles.storyCell}>{story.detail}</td>
                        <td>
                          <AttemptPips made={e.attemptsMade} status={e.status} />
                        </td>
                        <td>
                          <span
                            className={`${styles.mono} ${styles.truncate}`}
                            title={`${e.endpointId} (${e.tenantId})`}
                          >
                            {e.endpointId}
                          </span>
                        </td>
                        <td className={styles.muted} title={fmtTime(e.createdAt)}>
                          {fmtDuration(now - e.createdAt.getTime())} ago
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
