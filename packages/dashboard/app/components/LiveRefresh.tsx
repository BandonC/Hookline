"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ui.module.css";

const REFRESH_EVERY_S = 15;

// Re-runs the page's server component on a timer so the view stays current.
// The counter pauses while the tab is hidden so a forgotten tab doesn't spend
// D1 reads. `renderedAt` changes on each successful refresh, which restarts the
// count; if a refresh fails the count keeps climbing, so the age shown stays true.
export function LiveRefresh({ renderedAt }: { renderedAt: number }) {
  const router = useRouter();
  const [age, setAge] = useState(0);

  useEffect(() => {
    let elapsed = 0;
    setAge(0);
    const timer = setInterval(() => {
      if (document.hidden) return;
      elapsed += 1;
      setAge(elapsed);
      if (elapsed % REFRESH_EVERY_S === 0) router.refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [renderedAt, router]);

  return (
    <span className={styles.live}>
      <span className={styles.liveDot} aria-hidden="true" />
      {age === 0 ? "Updated just now" : `Updated ${age}s ago`}
    </span>
  );
}
