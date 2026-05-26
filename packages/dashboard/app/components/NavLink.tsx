"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./ui.module.css";

// Highlights the current section. "/" matches exactly; other hrefs match by
// prefix so detail routes (e.g. /events/[id]) don't light up a top-level item.
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={active ? styles.navActive : undefined}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
