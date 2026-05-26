import Link from "next/link";
import styles from "@/app/components/ui.module.css";

export default function EventNotFound() {
  return (
    <section className={styles.section}>
      <p className={styles.back}>
        <Link href="/">← Overview</Link>
      </p>
      <h2 className={styles.h2}>Event not found</h2>
      <p className={styles.empty}>
        No event with that ID. It may have been removed, or the ID is incorrect.
      </p>
    </section>
  );
}
