import { Bell } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { focusRing } from "@/components/ui/focus";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { unreadCount } from "@/lib/notifications/notifications";
import { cn } from "@/lib/ui/cn";

// The bell in the header: a link to /notifications with the number of unread ones (hidden when there are none).
// A server component; render it inside the shell (it waits for its own data, so the rest of the header does not wait).
export function NotificationBell() {
  return (
    <Suspense fallback={<BellLink count={0} />}>
      <BellWithCount />
    </Suspense>
  );
}

async function BellWithCount() {
  const auth = await getCurrentAuth();
  if (!auth || !auth.permissions.has("notification:read")) return null;
  let count = 0;
  try {
    count = await unreadCount(getAuthRuntime().db, auth);
  } catch {
    count = 0; // the bell is a convenience; a failed count must not break the page
  }
  return <BellLink count={count} />;
}

export function BellLink({ count }: { count: number }) {
  return (
    <Link
      href="/notifications"
      aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
      className={cn("relative inline-flex size-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg", focusRing)}
    >
      <Bell className="size-5" aria-hidden />
      {count > 0 && (
        <span className="absolute top-0.5 right-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white tabular-nums dark:text-background">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
