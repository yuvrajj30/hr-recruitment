import { Bell, CalendarCheck, CalendarDays, ChevronRight, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

// An Employee's home: self-service only. Nothing here shows or links to anyone else's information or to
// HR / Super Admin areas. Attendance and leave are shown as coming soon until those modules exist; their
// figures will come from real records only.
export function EmployeeHome({ firstName, organizationName, roleLabel }: { firstName: string; organizationName: string; roleLabel: string }) {
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

        <Tile icon={<CalendarCheck className="size-5 text-fg-subtle" aria-hidden />} title="My attendance" description="Your working hours and attendance history." soon>
          <p className="text-[13px] text-fg-muted">You will see your own attendance here once the Attendance module is switched on.</p>
        </Tile>

        <Tile icon={<CalendarDays className="size-5 text-fg-subtle" aria-hidden />} title="My leave" description="Apply for leave, see your balance and track approvals." soon>
          <p className="text-[13px] text-fg-muted">Leave requests and balances will appear here once the Leave module is switched on.</p>
        </Tile>

        <Tile icon={<Bell className="size-5 text-fg-subtle" aria-hidden />} title="Notifications" description="Messages about your requests and your work." soon>
          <p className="text-[13px] text-fg-muted">You have no notifications.</p>
        </Tile>
      </div>
    </div>
  );
}

function Tile({ icon, title, description, href, action, soon, children }: {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
  action?: string;
  soon?: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            {title}
            {soon && <Badge tone="neutral">Coming soon</Badge>}
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
