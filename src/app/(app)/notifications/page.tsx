import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { MarkAllReadButton, MarkReadButton } from "@/components/notifications/notification-controls";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listMyNotifications } from "@/lib/notifications/notifications";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Notifications · HRMS" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NotificationsContent />
    </Suspense>
  );
}

async function NotificationsContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fnotifications&reason=expired");
  if (!auth.permissions.has("notification:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Notifications" />
        <NoAccess what="see notifications" />
      </div>
    );
  }

  const rt = getAuthRuntime();
  const [items, tz] = await Promise.all([listMyNotifications(rt.db, auth, 50), attendanceTimezone(rt.db, auth)]);
  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `${unread} unread.` : "You are up to date."}
        actions={unread > 0 && <MarkAllReadButton />}
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={Bell} title="No notifications yet" description="Messages about your tasks and requests appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-4 px-5 py-3 text-[13px]">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-1.5 flex size-2 shrink-0" aria-hidden={n.read}>
                    {!n.read && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  <div className="min-w-0">
                    <p className={n.read ? "text-fg" : "font-semibold text-fg"}>
                      {!n.read && <span className="sr-only">Unread: </span>}
                      {n.taskId ? (
                        <Link href={`/tasks/${n.taskId}`} className="hover:underline">
                          {n.subject}
                        </Link>
                      ) : (
                        n.subject
                      )}
                    </p>
                    <p className="text-fg-muted">{n.body}</p>
                    <p className="mt-0.5 text-xs text-fg-subtle">{formatDateTime(n.createdAt, tz)}</p>
                  </div>
                </div>
                {!n.read && <MarkReadButton notificationId={n.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading notifications">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64" />
    </div>
  );
}
