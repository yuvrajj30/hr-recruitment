import { BadgeCheck, KeyRound, UserRound } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { AssignmentHistory, formatDay } from "@/components/employees/employee-bits";
import { NameForm, PasswordForm } from "@/components/users/self-forms";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getMyEmployee } from "@/lib/employees/employees";
import { EMPLOYMENT_TYPE_LABELS } from "@/lib/employees/rules";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate, formatDateTime } from "@/lib/recruitment/labels";
import { getMyAccount } from "@/lib/users/self";

// "My account": every signed-in person's own details. It only ever shows and changes the signed-in
// person's account.

export const metadata: Metadata = { title: "My account · HRMS" };

export default function MyAccountPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <MyAccountContent />
    </Suspense>
  );
}

async function MyAccountContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fme&reason=expired");
  const rt = getAuthRuntime();
  const [me, { timezone }, myEmployee] = await Promise.all([
    getMyAccount(rt.db, auth),
    getOrganizationSettings(rt.db, auth).catch(() => ({ timezone: "UTC" })),
    auth.permissions.has("self:profile_read") ? getMyEmployee(rt.db, auth) : Promise.resolve(null),
  ]);
  const canEdit = auth.permissions.has("self:profile_update");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="My account" description="Your own details. Only you can change your password." />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Your details</CardTitle>
            <CardDescription>Your email is your sign-in name. Ask HR if it needs to change.</CardDescription>
          </div>
          <UserRound className="size-5 text-fg-subtle" aria-hidden />
        </CardHeader>
        <CardBody className="space-y-5">
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
            <Detail label="Email">{me.email}</Detail>
            <Detail label="Role">{me.role ? ROLE_LABELS[me.role] : "No role"}</Detail>
            <Detail label="Organisation">{me.organizationName}</Detail>
            <Detail label="Member since">{me.memberSince ? formatDate(me.memberSince, timezone) : "—"}</Detail>
            <Detail label="Last sign-in">{me.lastLoginAt ? formatDateTime(me.lastLoginAt, timezone) : "—"}</Detail>
          </dl>
          {canEdit && <NameForm name={me.name} />}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>My employee record</CardTitle>
            <CardDescription>Your job details as HR holds them. Ask HR if anything is wrong.</CardDescription>
          </div>
          <BadgeCheck className="size-5 text-fg-subtle" aria-hidden />
        </CardHeader>
        <CardBody className="space-y-5">
          {myEmployee ? (
            <>
              <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
                <Detail label="Employee code">{myEmployee.employeeCode}</Detail>
                <Detail label="Designation">{myEmployee.designation ?? "—"}</Detail>
                <Detail label="Department">{myEmployee.department ?? "—"}</Detail>
                <Detail label="Outlet">{myEmployee.outlet ?? "—"}</Detail>
                <Detail label="Joined on">{formatDay(myEmployee.joinedOn)}</Detail>
                <Detail label="Employment type">{EMPLOYMENT_TYPE_LABELS[myEmployee.employmentType]}</Detail>
              </dl>
              <div>
                <h3 className="mb-2 text-[13px] font-medium text-fg">Assignment history</h3>
                <AssignmentHistory history={myEmployee.history} timezone={timezone} showChangedBy={false} showManager={false} />
              </div>
            </>
          ) : (
            <p className="text-[13px] text-fg-muted">HR has not linked an employee record to this account yet.</p>
          )}
        </CardBody>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Change password</CardTitle>
              <CardDescription>Your other browsers and devices are signed out; this one stays signed in.</CardDescription>
            </div>
            <KeyRound className="size-5 text-fg-subtle" aria-hidden />
          </CardHeader>
          <CardBody>
            <PasswordForm />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}
