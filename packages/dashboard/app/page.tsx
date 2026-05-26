import Link from "next/link";
import { listEndpoints, recentEvents, eventCounts } from "@/lib/queries";
import { fmtTime } from "@/lib/format";
import { StatusBadge } from "./components/StatusBadge";
import styles from "./components/ui.module.css";

export const dynamic = "force-dynamic";

const rowTint: Partial<Record<string, string>> = {
  failed: styles.rowFailed,
  pending: styles.rowPending,
};

export default async function Home() {
  const [endpoints, evts, counts] = await Promise.all([
    listEndpoints(),
    recentEvents(),
    eventCounts(),
  ]);

  return (
    <>
      <h1 className={styles.h1}>Overview</h1>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>Endpoints</h2>
          <span className={styles.count}>{endpoints.length} total</span>
        </div>
        {endpoints.length === 0 ? (
          <p className={styles.empty}>No endpoints registered.</p>
        ) : (
          <div className={styles.card}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Registered endpoints</caption>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>URL</th>
                    <th>Description</th>
                    <th className={styles.num}>Pending</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span className={`${styles.mono} ${styles.truncate}`} title={e.id}>
                          {e.id}
                        </span>
                      </td>
                      <td>
                        <span className={`${styles.mono} ${styles.truncate}`} title={e.url}>
                          {e.url}
                        </span>
                      </td>
                      <td>{e.description ?? <span className={styles.muted}>—</span>}</td>
                      <td className={styles.num}>
                        {e.pending > 0 ? (
                          <span className={styles.hot}>{e.pending}</span>
                        ) : (
                          <span className={styles.muted}>0</span>
                        )}
                      </td>
                      <td className={styles.muted}>{fmtTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>Recent deliveries</h2>
          <span className={styles.count}>
            {counts.total} events · {counts.pending} pending · {counts.failed} failed
          </span>
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
                    <th>Endpoint</th>
                    <th>Status</th>
                    <th className={styles.num}>Attempts</th>
                    <th>Next attempt</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {evts.map((e) => (
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
                        <span className={`${styles.mono} ${styles.truncate}`} title={e.endpointId}>
                          {e.endpointId}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={e.status} />
                      </td>
                      <td className={styles.num}>{e.attemptCount}</td>
                      <td className={styles.muted}>{fmtTime(e.nextAttemptAt)}</td>
                      <td className={styles.muted}>{fmtTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
