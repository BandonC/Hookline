import type { Tone } from "@/lib/narrate";
import styles from "./ui.module.css";

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {label}
    </span>
  );
}
