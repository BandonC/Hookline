"use client";

import { useEffect, useState } from "react";
import styles from "./ui.module.css";

// The boot script in layout.tsx sets data-theme before paint; this reads that
// external state on mount (it can't be derived from props) and flips it.
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    setTheme(t === "dark" ? "dark" : t === "light" ? "light" : null);
  }, []);

  function toggle() {
    const isDark =
      theme === "dark" ||
      (theme === null && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // private mode / storage disabled — the choice just won't persist.
    }
    setTheme(next);
  }

  // null until mounted; show the "switch to dark" glyph as the default.
  const glyph = theme === "dark" ? "☀" : "☾";
  return (
    <button className={styles.toggle} onClick={toggle} aria-label="Toggle light/dark theme">
      {glyph}
    </button>
  );
}
