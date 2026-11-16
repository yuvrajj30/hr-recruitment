import { Blocks, Building2, UserRound } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { isRoleKey, ROLE_LABELS } from "@/lib/auth/roles";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { EmployeeHome } from "@/components/dashboard/employee-home";

export const metadata: Metadata = { title: "Dashboard · HRMS" };

// Any of these means the person works on HR or administration, not only on themselves.
const HR_AREAS = ["job:read", "application:read", "user:read", "employee:read", "attendance:read", "leave:read", "report:read"] as const;

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}

// Only real information is shown here. Metric cards (headcount, attendance, open jobs...) are added
// by each module when it ships, from real records; nothing is invented in the meantime.
async function DashboardContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fdashboard&reason=expired");
  const firstName = auth.user.name.trim().split(/\s+/)[0] || auth.user.name;

  // Someone without any HR or administrative permission (an Employee) gets the self-service home.
  // Deciding by permissions, not by role name, keeps this right if a role's permissions ever change.
  const isStaffAdmin = HR_AREAS.some((p) => auth.permissions.has(p));
  if (!isStaffAdmin) {
    const role = auth.roleKeys.find(isRoleKey);
    return <EmployeeHome firstName={firstName} organizationName={auth.organization?.name ?? ""} roleLabel={role ? ROLE_LABELS[role] : "Employee"} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${firstName}`} description={auth.organization ? `Your workspace at ${auth.organization.name}.` : "You are not in an organisation yet."} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your account</CardTitle>
              <CardDescription>The details you sign in with.</CardDescription>
            </div>
            <UserRound className="size-5 text-fg-subtle" aria-hidden />
          </CardHeader>
          <CardBody>
            <dl className="grid gap-3 text-[13px]">
              <Row label="Name">{auth.user.name}</Row>
              <Row label="Email">{auth.user.email}</Row>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Organisation</CardTitle>
              <CardDescription>Your access in this organisation.</CardDescription>
            </div>
            <Building2 className="size-5 text-fg-subtle" aria-hidden />
          </CardHeader>
          <CardBody>
            <dl className="grid gap-3 text-[13px]">
              <Row label="Organisation">{auth.organization?.name ?? "None"}</Row>
              <Row label="Roles">
                {auth.roleKeys.length > 0 ? (
                  <span className="flex flex-wrap gap-1.5">
                    {auth.roleKeys.map((role) => (
                      <Badge key={role} tone="accent">
                        {roleLabel(role)}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-fg-muted">No roles assigned</span>
                )}
              </Row>
              <Row label="Permissions">
                <span className="tabular">{auth.permissions.size}</span>
              </Row>
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <EmptyState
          icon={Blocks}
          title="HR modules arrive one at a time"
          description="Employees, recruitment, attendance, leave and the other modules will appear in the sidebar as each one is released and tested. Figures on this page will come only from real records."
        />
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}

// Display names come from the one role definition (src/lib/auth/roles.ts).
const roleLabel = (key: string) => (isRoleKey(key) ? ROLE_LABELS[key] : key);

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-44" />
    </div>
  );
}
