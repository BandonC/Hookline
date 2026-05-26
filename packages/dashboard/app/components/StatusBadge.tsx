import styles from "./ui.module.css";

const variant: Record<string, string> = {
  pending: styles.badgePending,
  delivered: styles.badgeDelivered,
  failed: styles.badgeFailed,
};

export function StatusBadge({ status }: { status: "pending" | "delivered" | "failed" }) {
  return <span className={`${styles.badge} ${variant[status]}`}>{status}</span>;
}
