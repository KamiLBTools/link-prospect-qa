"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/qa", label: "Runs" },
  { href: "/index", label: "Link Monitor" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav>
      <span className="brand">Prospect QA</span>
      {LINKS.map((link) => (
        <a
          key={link.href}
          href={link.href}
          // `/qa` is active for every page inside it, but the sibling tool's
          // link never lights up here.
          className={
            link.href === "/qa" && !pathname.startsWith("/index") ? "on" : ""
          }
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
