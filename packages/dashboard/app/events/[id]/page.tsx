import Link from "next/link";
import { notFound } from "next/navigation";
import { eventWithAttempts } from "@/lib/queries";
import { fmtTime } from "@/lib/format";
import { StatusBadge } from "@/app/components/StatusBadge";
import styles from "@/app/components/ui.module.css";

export const dynamic = "force-dynamic";

export default async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await eventWithAttempts(id);
  if (!data) notFound();
  const { event, attempts, blockedBy } = data;

  return (
    <>
      <p className={styles.back}>
        <Link href="/">← Overview</Link>
      </p>

      <section className={styles.section}>
        <h2 className={styles.h2}>Event</h2>
        <div className={styles.metaGrid}>
          <div>
            <span className={styles.muted}>ID</span>
            <div className={styles.mono}>{event.id}</div>
          </div>
          <div>
            <span className={styles.muted}>Endpoint</span>
            <div className={styles.mono}>{event.endpointId}</div>
          </div>
          <div>
            <span className={styles.muted}>Status</span>
            <div>
              <StatusBadge status={event.status} />
              {event.status === "pending" && event.lastDeferReason === "rate_limited" ? (
                <>
                  {" "}
                  <span className={`${styles.badge} ${styles.badgeThrottled}`}>throttled</span>
                </>
              ) : null}
              {event.status === "pending" && event.lastDeferReason === "breaker_open" ? (
                <>
                  {" "}
                  <span className={`${styles.badge} ${styles.badgeFailed}`}>breaker open</span>
                </>
              ) : null}
            </div>
          </div>
          <div>
            <span className={styles.muted}>Attempts</span>
            <div>{event.attemptCount}</div>
          </div>
          <div>
            <span className={styles.muted}>Next attempt</span>
            <div>{fmtTime(event.nextAttemptAt)}</div>
          </div>
          <div>
            <span className={styles.muted}>Ordering key</span>
            <div>
              {event.orderingKey !== null ? (
                <span className={styles.mono}>{event.orderingKey}</span>
              ) : (
                <span className={styles.muted}>—</span>
              )}
            </div>
          </div>
          <div>
            <span className={styles.muted}>Queue position</span>
            <div>
              {event.orderingKey === null ? (
                <span className={styles.muted}>—</span>
              ) : blockedBy !== null ? (
                <>
                  blocked behind{" "}
                  <Link className={styles.mono} href={`/events/${blockedBy.id}`}>
                    {blockedBy.id}
                  </Link>
                </>
              ) : event.status === "pending" ? (
                <span className={styles.muted}>head of queue</span>
              ) : (
                <span className={styles.muted}>—</span>
              )}
            </div>
          </div>
          <div>
            <span className={styles.muted}>Created</span>
            <div>{fmtTime(event.createdAt)}</div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Attempt history</h2>
        {attempts.length === 0 ? (
          <p className={styles.empty}>No attempts recorded yet.</p>
        ) : (
          <div className={styles.card}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Delivery attempts for {event.id}</caption>
                <thead>
                  <tr>
                    <th className={styles.num}>#</th>
                    <th>Status code</th>
                    <th className={styles.num}>Latency</th>
                    <th>Response snippet</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => {
                    const ok = a.statusCode != null && a.statusCode >= 200 && a.statusCode < 300;
                    return (
                      <tr key={a.id}>
                        <td className={styles.num}>{a.attemptNumber}</td>
                        <td>
                          {a.statusCode != null ? (
                            <span className={ok ? styles.codeOk : styles.codeErr}>
                              {a.statusCode}
                            </span>
                          ) : (
                            <span className={styles.muted}>network error</span>
                          )}
                        </td>
                        <td className={styles.num}>
                          {a.latencyMs != null ? (
                            `${a.latencyMs} ms`
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td className={styles.snippet}>
                          {a.responseSnippet ? (
                            <code>{a.responseSnippet}</code>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td className={styles.muted}>{fmtTime(a.attemptedAt)}</td>
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
