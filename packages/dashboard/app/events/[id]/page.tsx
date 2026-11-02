import Link from "next/link";
import { notFound } from "next/navigation";
import { eventWithAttempts } from "@/lib/queries";
import { fmtDuration, fmtTime } from "@/lib/format";
import { describeEvent } from "@/lib/narrate";
import { LiveRefresh } from "@/app/components/LiveRefresh";
import { StatusBadge } from "@/app/components/StatusBadge";
import styles from "@/app/components/ui.module.css";

export const dynamic = "force-dynamic";

export default async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await eventWithAttempts(id);
  if (!data) notFound();
  const { event, attempts, blockedBy, deadLetter } = data;

  const now = Date.now();
  const attemptsMade = attempts.at(-1)?.attemptNumber ?? 0;
  const story = describeEvent({ ...event, attemptsMade }, now);

  return (
    <>
      <p className={styles.back}>
        <Link href="/">← Overview</Link>
      </p>

      <section className={styles.hero} data-tone={story.tone}>
        <div className={styles.heroTop}>
          <h1 className={`${styles.eyebrow} ${styles.mono}`}>{event.id}</h1>
          {event.status === "pending" ? <LiveRefresh renderedAt={now} /> : null}
        </div>
        <div className={styles.verdict}>
          <StatusBadge tone={story.tone} label={story.label} />
          <p className={styles.headlineSmall}>{story.detail}</p>
        </div>
        {blockedBy !== null ? (
          <p className={styles.heroNote}>
            Behind{" "}
            <Link className={styles.mono} href={`/events/${blockedBy.id}`}>
              {blockedBy.id}
            </Link>{" "}
            in its ordered queue.
          </p>
        ) : null}
      </section>

      <div className={styles.detailGrid}>
        <section className={styles.section}>
          <h2 className={styles.h2}>Delivery timeline</h2>
          <ol className={styles.timeline}>
            <li data-tone="quiet">
              <div className={styles.timelineHead}>
                <strong>Received</strong>
                <span className={styles.muted} title={fmtTime(event.createdAt)}>
                  {fmtDuration(now - event.createdAt.getTime())} ago
                </span>
              </div>
            </li>
            {attempts.map((a, i) => {
              const ok = a.statusCode != null && a.statusCode >= 200 && a.statusCode < 300;
              const previous = i === 0 ? event.createdAt : attempts[i - 1].attemptedAt;
              return (
                <li key={a.id} data-tone={ok ? "ok" : "bad"}>
                  <div className={styles.timelineHead}>
                    <strong>
                      Attempt {a.attemptNumber}:{" "}
                      {a.statusCode != null ? `HTTP ${a.statusCode}` : "network error"}
                    </strong>
                    <span className={styles.muted} title={fmtTime(a.attemptedAt)}>
                      {fmtDuration(a.attemptedAt.getTime() - previous.getTime())} later
                      {a.latencyMs != null ? ` · ${a.latencyMs} ms` : ""}
                    </span>
                  </div>
                  {a.responseSnippet ? <code className={styles.snippet}>{a.responseSnippet}</code> : null}
                </li>
              );
            })}
            {event.status === "pending" ? (
              <li data-tone={story.tone} data-open="true">
                <div className={styles.timelineHead}>
                  <strong>{story.label}</strong>
                  <span className={styles.muted} title={fmtTime(event.nextAttemptAt)}>
                    Next: {fmtTime(event.nextAttemptAt)}
                  </span>
                </div>
              </li>
            ) : null}
            {deadLetter !== null ? (
              <li data-tone="bad">
                <div className={styles.timelineHead}>
                  <strong>Moved to dead letters</strong>
                  <span className={styles.muted} title={fmtTime(deadLetter.failedAt)}>
                    {fmtDuration(now - deadLetter.failedAt.getTime())} ago
                  </span>
                </div>
                {deadLetter.finalError ? (
                  <code className={styles.snippet}>{deadLetter.finalError}</code>
                ) : null}
              </li>
            ) : null}
          </ol>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Details</h2>
          <dl className={styles.metaList}>
            <div>
              <dt>Endpoint</dt>
              <dd className={styles.mono}>{event.endpointId}</dd>
            </div>
            <div>
              <dt>Ordering key</dt>
              <dd className={event.orderingKey !== null ? styles.mono : styles.muted}>
                {event.orderingKey ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Queue position</dt>
              <dd className={styles.muted}>
                {event.orderingKey === null || event.status !== "pending"
                  ? "—"
                  : blockedBy !== null
                    ? "Blocked"
                    : "Head of queue"}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{fmtTime(event.createdAt)}</dd>
            </div>
          </dl>
        </section>
      </div>
    </>
  );
}
