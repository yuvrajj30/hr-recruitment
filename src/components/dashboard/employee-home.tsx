import { Bell, CalendarCheck, CalendarDays, ChevronRight, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { attendanceTimezone, getMyAttendance, type MyAttendance } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import type { PermissionKey } from "@/lib/auth/permission-keys";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getMyLeave, type MyLeave } from "@/lib/leave/leave";
import { listMyNotifications, type NotificationView } from "@/lib/notifications/notifications";
import { formatDateTime } from "@/lib/recruitment/labels";

// An Employee's home: self-service only. Nothing here shows or links to anyone else's information or to
// HR / Super Admin areas. Attendance and leave figures come from the person's own records only (the same
// self-service reads as the Attendance and Leave pages); a card is left out when the role cannot read it.
export async function EmployeeHome({ firstName, organizationName, roleLabel }: { firstName: string; organizationName: string; roleLabel: string }) {
  const auth = await getCurrentAuth();
  const db = getAuthRuntime().db;
  const now = new Date();
  const tz = auth ? await attendanceTimezone(db, auth) : "UTC";
  const can = (key: PermissionKey) => Boolean(auth?.permissions.has(key));
  const [latest, attendance, leave] = await Promise.all([
    auth && can("notification:read") ? listMyNotifications(db, auth, 5) : Promise.resolve([] as NotificationView[]),
    auth && can("self:attendance_read") ? getMyAttendance(db, auth, now) : Promise.resolve(null),
    auth && can("self:leave_read") ? getMyLeave(db, auth, localDay(now, tz)) : Promise.resolve(null),
  ]);
  const year = Number(localDay(now, tz).slice(0, 4));
  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${firstName}`} description={`Your self-service space at ${organizationName}.`} />

      <div className="grid gap-4 md:grid-cols-2">
        <Tile
          icon={<UserRound className="size-5 text-fg-subtle" aria-hidden />}
          title="My details"
          description="Your name, sign-in email and password."
          href="/me"
          action="Open my account"
        >
          <p className="text-[13px] text-fg-muted">
            You are signed in as <Badge tone="neutral">{roleLabel}</Badge>
          </p>
        </Tile>

        {attendance && (
          <Tile icon={<CalendarCheck className="size-5 text-fg-subtle" aria-hidden />} title="My attendance" description="Clock in and out, and see your shifts and hours." href="/attendance" action="Open my attendance">
            <AttendanceSummary me={attendance} tz={tz} now={now} />
          </Tile>
        )}

        {leave && (
          <Tile icon={<CalendarDays className="size-5 text-fg-subtle" aria-hidden />} title="My leave" description="Apply for leave, see your balance and track approvals." href="/leave" action="Open my leave">
            <LeaveSummary me={leave} year={year} />
          </Tile>
        )}

        <Tile icon={<Bell className="size-5 text-fg-subtle" aria-hidden />} title="Notifications" description="Messages about your requests and your work." href="/notifications" action="See all notifications">
          {latest.length === 0 ? (
            <p className="text-[13px] text-fg-muted">You have no notifications.</p>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {latest.map((n) => (
                <li key={n.id}>
                  <p className={n.read ? "text-fg" : "font-semibold text-fg"}>{n.subject}</p>
                  <p className="text-xs text-fg-muted">{formatDateTime(n.createdAt, tz)}</p>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </div>
    </div>
  );
}

const NOT_LINKED = "Your account is not linked to an employee record yet. Ask HR to link it.";

function AttendanceSummary({ me, tz, now }: { me: MyAttendance; tz: string; now: Date }) {
  if (!me.linked) return <p className="text-[13px] text-fg-muted">{NOT_LINKED}</p>;
  if (me.open) {
    return <p className="text-[13px] text-fg">You are clocked in since <span className="font-semibold">{formatDateTime(me.open.clockInAt, tz)}</span>{me.open.onBreak ? ", on a break" : ""}.</p>;
  }
  const next = me.upcoming.find((s) => s.status === "PLANNED" && s.endsAt.getTime() > now.getTime());
  if (!next) return <p className="text-[13px] text-fg-muted">You have no shifts planned yet.</p>;
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return (
    <p className="text-[13px] text-fg">
      Next shift: <span className="font-semibold">{formatDateTime(next.startsAt, tz)} – {time.format(next.endsAt)}</span> at {next.outlet}.
    </p>
  );
}

function LeaveSummary({ me, year }: { me: MyLeave; year: number }) {
  if (!me.linked) return <p className="text-[13px] text-fg-muted">{NOT_LINKED}</p>;
  // Paid types HR has not set up yet are left out (the Leave page says "Not set up yet" for those).
  const balances = me.balances.filter((b) => b.paid && b.available !== null && b.year === year && !me.notConfigured.includes(b.typeCode));
  const waiting = me.requests.filter((r) => r.status === "PENDING").length;
  return (
    <div className="space-y-2 text-[13px]">
      {balances.length === 0 ? (
        <p className="text-fg-muted">No leave balances yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {balances.map((b) => (
            <li key={b.typeId} className="text-fg">
              {b.typeName}: <span className="font-semibold">{b.available}</span> {b.available === 1 ? "day" : "days"}
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 && <p className="text-fg-muted">{waiting === 1 ? "1 request is" : `${waiting} requests are`} waiting for HR.</p>}
    </div>
  );
}

function Tile({ icon, title, description, href, action, children }: {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
  action?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {icon}
      </CardHeader>
      <CardBody className="space-y-3">
        {children}
        {href && action && (
          <Link href={href} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-fg hover:underline">
            {action}
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        )}
      </CardBody>
    </Card>
  );
}
