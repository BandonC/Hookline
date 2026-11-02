import Link from "next/link";
import { listDeadLetters } from "@/lib/queries";
import { fmtDuration, fmtTime } from "@/lib/format";
import {
  MAX_ATTEMPTS,
  deadLetterHeadline,
  explainFailure,
  groupDeadLetters,
} from "@/lib/narrate";
import { AttemptPips } from "@/app/components/AttemptPips";
import { StatusBadge } from "@/app/components/StatusBadge";
import styles from "@/app/components/ui.module.css";

export const dynamic = "force-dynamic";

export default async function DeadLetters() {
  const rows = await listDeadLetters();
  const now = Date.now();
  const groups = groupDeadLetters(rows);

  if (rows.length === 0) {
    return (
      <section className={styles.hero} data-tone="ok">
        <h1 className={styles.eyebrow}>Dead letters</h1>
        <p className={styles.headline}>Nothing here.</p>
        <p className={styles.heroNote}>
          No event has run out of attempts. Anything that does will be kept on this page.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className={styles.hero} data-tone="bad">
        <h1 className={styles.eyebrow}>Dead letters</h1>
        <p className={styles.headline}>{deadLetterHeadline(rows.length, groups.length)}</p>
        <p className={styles.heroNote}>
          {`Latest ${fmtDuration(now - rows[0].failedAt.getTime())} ago. Each of these used all ${MAX_ATTEMPTS} attempts, so Hookline stopped retrying and kept them here. It won't resend them: once the receiver is fixed, send the event again from your app.`}
        </p>
      </section>

      {groups.map((group) => (
        <section key={group.endpointId} className={styles.section}>
          <div className={styles.sectionHead}>
            <div className={styles.groupTitle}>
              <h2>{group.name}</h2>
              <span className={styles.mono}>{group.endpointId}</span>
            </div>
            <StatusBadge tone="bad" label={`${group.rows.length} dead-lettered`} />
          </div>

          <ul className={styles.causes}>
            {group.errors.map(({ error, n }) => (
              <li key={error ?? "none"}>
                <strong className={styles.mono}>
                  {n} × {error ?? "unknown"}
                </strong>
                <span>{explainFailure(error)}</span>
              </li>
            ))}
          </ul>

          <div className={styles.card}>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Dead-lettered events for {group.name}</caption>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Final error</th>
                    <th>Attempts</th>
                    <th>Tried for</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((d) => (
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
                      <td>{d.finalError ?? <span className={styles.muted}>—</span>}</td>
                      <td>
                        <AttemptPips made={d.attemptsMade} status="failed" />
                      </td>
                      <td>{fmtDuration(d.failedAt.getTime() - d.createdAt.getTime())}</td>
                      <td className={styles.muted} title={fmtTime(d.failedAt)}>
                        {fmtDuration(now - d.failedAt.getTime())} ago
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
