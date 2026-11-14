"use client";

import { Menu, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { SidePanel, SidePanelClose } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { OrganizationSummary } from "@/lib/auth/organizations";
import type { NavItem } from "@/lib/navigation";
import { OrgSwitcher } from "./org-switcher";
import { SidebarNav } from "./sidebar-nav";
import { UserMenu } from "./user-menu";

export type ShellProps = {
  user: { name: string; email: string };
  organization: OrganizationSummary | null;
  organizations: OrganizationSummary[];
  navigation: NavItem[];
  children: ReactNode;
};

// The frame around every signed-in page.
//   Laptop and up (lg, 1024px+): full sidebar with labels.
//   Tablet (md, 768px+): narrow icon rail with tooltips.
//   Phone: no sidebar; a menu button opens it as a slide-out panel.
export function AppShell({ user, organization, organizations, navigation, children }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={300}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh">
        {/* Tablet rail */}
        <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col items-center gap-4 border-r border-border bg-surface py-3 md:flex lg:hidden">
          <OrgSwitcher current={organization} organizations={organizations} compact />
          <SidebarNav items={navigation} variant="rail" />
        </aside>
        {/* Laptop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-5 border-r border-border bg-surface px-3 py-3 lg:flex">
          <OrgSwitcher current={organization} organizations={organizations} />
          <SidebarNav items={navigation} variant="full" />
          <ProductMark className="mt-auto px-3" />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur sm:px-6">
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
              <Menu />
            </Button>
            <span className="truncate text-sm font-semibold text-fg md:hidden">{organization?.name ?? "HRMS"}</span>
            <div className="ml-auto flex items-center gap-2">
              <UserMenu name={user.name} email={user.email} />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
            {children}
          </main>
        </div>
      </div>

      {/* Phone menu */}
      <SidePanel open={menuOpen} onOpenChange={setMenuOpen} title="Navigation">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <OrgSwitcher current={organization} organizations={organizations} />
          </div>
          <SidePanelClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close navigation">
              <X />
            </Button>
          </SidePanelClose>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav items={navigation} variant="full" onNavigate={() => setMenuOpen(false)} />
        </div>
        <ProductMark className="px-6 pb-4" />
      </SidePanel>
    </TooltipProvider>
  );
}

function ProductMark({ className }: { className?: string }) {
  return <p className={`text-[11px] font-medium tracking-wide text-fg-subtle ${className ?? ""}`}>HRMS</p>;
}
