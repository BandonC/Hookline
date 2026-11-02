import { MAX_ATTEMPTS } from "@/lib/narrate";
import styles from "./ui.module.css";

// One pip per allowed attempt. Used pips are failures, except the last one on a
// delivered event, which is the success.
export function AttemptPips({
  made,
  status,
}: {
  made: number;
  status: "pending" | "delivered" | "failed";
}) {
  const pips = Array.from({ length: Math.max(MAX_ATTEMPTS, made) }, (_, i) => i + 1);
  return (
    <span
      className={styles.pips}
      role="img"
      aria-label={`${made} of ${MAX_ATTEMPTS} attempts used`}
      title={`${made} of ${MAX_ATTEMPTS} attempts used`}
    >
      {pips.map((n) => (
        <span
          key={n}
          className={styles.pip}
          data-state={
            n > made ? "unused" : n === made && status === "delivered" ? "ok" : "failed"
          }
        />
      ))}
    </span>
  );
}
