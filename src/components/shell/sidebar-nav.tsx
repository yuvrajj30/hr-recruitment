"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusRing } from "@/components/ui/focus";
import { Tooltip } from "@/components/ui/tooltip";
import { isActivePath, type NavItem, type NavSection } from "@/lib/navigation";
import { cn } from "@/lib/ui/cn";
import { NAV_ICONS } from "./nav-icons";

const SECTION_LABELS: Record<NavSection, string> = { workspace: "Workspace", administration: "Administration" };

// "full" = icon + label (laptops, phones' slide-out menu). "rail" = icons only with tooltips (tablets).
export function SidebarNav({ items, variant, onNavigate }: { items: NavItem[]; variant: "full" | "rail"; onNavigate?: () => void }) {
  const pathname = usePathname();
  const sections = (["workspace", "administration"] as const).filter((s) => items.some((i) => i.section === s));

  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section}>
          {variant === "full" && (
            <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">{SECTION_LABELS[section]}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {items
              .filter((i) => i.section === section)
              .map((item) => {
                const Icon = NAV_ICONS[item.key];
                const active = isActivePath(pathname, item.href);
                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={variant === "rail" ? item.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md text-[13px] font-medium transition-colors",
                      variant === "full" ? "h-9 px-3" : "size-10 justify-center",
                      active ? "bg-accent-soft text-accent-fg" : "text-fg-muted hover:bg-surface-muted hover:text-fg",
                      focusRing,
                    )}
                  >
                    <Icon className={cn("size-[18px] shrink-0", active ? "text-accent-fg" : "text-fg-subtle")} aria-hidden />
                    {variant === "full" && <span className="truncate">{item.label}</span>}
                  </Link>
                );
                return <li key={item.key}>{variant === "rail" ? <Tooltip content={item.label}>{link}</Tooltip> : link}</li>;
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
