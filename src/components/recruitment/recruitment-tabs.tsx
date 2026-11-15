"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusRing } from "@/components/ui/focus";
import { cn } from "@/lib/ui/cn";

export type RecruitmentTab = { href: string; label: string };

// The sections of Recruitment, shown under the sidebar's Recruitment entry on every recruitment page.
// The server decides which tabs a person gets (by permission); this only draws them.
export function RecruitmentTabs({ tabs }: { tabs: RecruitmentTab[] }) {
  const pathname = usePathname();
  if (tabs.length < 2) return null;
  // "/recruitment" (jobs) also owns "/recruitment/jobs/..."; the others own their own folder.
  const isActive = (href: string) =>
    href === "/recruitment" ? pathname === "/recruitment" || pathname.startsWith("/recruitment/jobs") : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Recruitment sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {tabs.map((tab) => {
        const active = isActive(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors",
              active ? "border-accent text-accent-fg" : "border-transparent text-fg-muted hover:text-fg",
              focusRing,
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
