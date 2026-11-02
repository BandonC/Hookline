import Link from "next/link";
import styles from "./ui.module.css";

// The product in one picture: every event enters on the left, waits on the line,
// then either lands as delivered or drops onto the hook as a dead letter. The
// dashes only move while something is actually waiting.
export function DeliveryLine({
  counts,
}: {
  counts: { total: number; pending: number; delivered: number; failed: number };
}) {
  const moving = counts.pending > 0;
  return (
    <div className={styles.flow} data-moving={moving}>
      <div className={`${styles.station} ${styles.stationReceived}`}>
        <strong>{counts.total}</strong>
        <span>received</span>
      </div>
      <svg
        className={styles.flowIn}
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 5 H100" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={`${styles.station} ${styles.stationWaiting}`} data-tone={moving ? "wait" : "quiet"}>
        <strong>{counts.pending}</strong>
        <span>on the line</span>
      </div>
      <svg
        className={styles.flowFork}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* y values are the two row centres: rows are 48px with a 10px gap, so
            the fork is 106px tall and they fall at 24/106 and 82/106. */}
        <path d="M0 22.6 H30" vectorEffect="non-scaling-stroke" />
        <path d="M30 22.6 H100" data-branch="ok" vectorEffect="non-scaling-stroke" />
        <path
          d="M30 22.6 C55 22.6 55 77.4 80 77.4 H100"
          data-branch="bad"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className={`${styles.station} ${styles.stationDelivered}`} data-tone="ok">
        <strong>{counts.delivered}</strong>
        <span>delivered</span>
      </div>
      <Link
        href="/dead-letters"
        className={`${styles.station} ${styles.stationDead}`}
        data-tone={counts.failed > 0 ? "bad" : "quiet"}
      >
        <strong>{counts.failed}</strong>
        <span>dead-lettered</span>
      </Link>
    </div>
  );
}
