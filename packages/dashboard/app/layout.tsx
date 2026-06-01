import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "./components/ThemeToggle";
import { NavLink } from "./components/NavLink";
import styles from "./components/ui.module.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hookline",
  description: "Webhook delivery — read-only dashboard",
};

// Restore the saved theme BEFORE first paint to avoid a dark flash on
// systems where prefers-color-scheme is dark and the user explicitly chose
// light (or vice versa). Inlined into <head> as a raw <script>, so it runs
// synchronously before the browser parses CSS — next/script's
// beforeInteractive strategy is too late (runs before hydration, but
// AFTER first paint).
const themeBoot = `try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning: the boot script sets data-theme on <html> before
  // hydration, which would otherwise look like a server/client attribute mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <header className={styles.header}>
          <Link href="/" className={styles.brand}>
            Hookline
          </Link>
          <nav className={styles.nav}>
            <NavLink href="/" label="Overview" />
            <NavLink href="/dead-letters" label="Dead letters" />
            <ThemeToggle />
          </nav>
        </header>
        <main className={styles.container}>{children}</main>
      </body>
    </html>
  );
}
