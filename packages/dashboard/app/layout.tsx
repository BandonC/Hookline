import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { ThemeToggle } from "./components/ThemeToggle";
import { NavLink } from "./components/NavLink";
import styles from "./components/ui.module.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hookline",
  description: "Webhook delivery — read-only dashboard",
};

// Restore the saved theme before first paint to avoid a flash of the wrong
// palette. beforeInteractive inlines this into the initial HTML and runs it
// before hydration; the toggle persists the choice to localStorage.
const themeBoot = `try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning: the boot script sets data-theme on <html> before
  // hydration, which would otherwise look like a server/client attribute mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script id="theme-boot" strategy="beforeInteractive">
          {themeBoot}
        </Script>
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
