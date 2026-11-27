import { redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { AppShell } from "@/components/shell/app-shell";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";
import { listUserOrganizations } from "@/lib/auth/organizations";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { buildNavigation } from "@/lib/navigation";

// Every page inside the (app) folder gets the sidebar and header, and only signed-in people see them.
// The folder name in brackets does not appear in the address: /dashboard stays /dashboard.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <SignedInShell>{children}</SignedInShell>
    </Suspense>
  );
}

async function SignedInShell({ children }: { children: ReactNode }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?reason=expired");

  const organizations = await listUserOrganizations(getAuthRuntime().db, auth.user.id);
  return (
    <AppShell
      user={{ name: auth.user.name, email: auth.user.email }}
      organization={auth.organization}
      organizations={organizations}
      navigation={buildNavigation(auth.permissions)}
      bell={<NotificationBell />}
    >
      {children}
    </AppShell>
  );
}
