import Link from "next/link";
import { listDeadLetters } from "@/lib/queries";
import { fmtTime } from "@/lib/format";
import styles from "@/app/components/ui.module.css";

export const dynamic = "force-dynamic";

export default async function DeadLetters() {
  const rows = await listDeadLetters();

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.h2}>Dead letters</h2>
        <span className={styles.count}>{rows.length} total</span>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>No dead-lettered events.</p>
      ) : (
        <div className={styles.card}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Event</th>
                <th>Endpoint</th>
                <th>Final error</th>
                <th>Failed at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.eventId}>
                  <td>
                    <Link
                      className={`${styles.mono} ${styles.truncate}`}
                      title={d.eventId}
                      href={`/events/${d.eventId}`}
                    >
                      {d.eventId}
                    </Link>
                  </td>
                  <td>
                    <span className={`${styles.mono} ${styles.truncate}`} title={d.endpointId}>
                      {d.endpointId}
                    </span>
                  </td>
                  <td>{d.finalError ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.muted}>{fmtTime(d.failedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
