import { KeyRound, Plus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { EmployeeStatusBadge } from "@/components/employees/employee-bits";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { listEmployees, listStructure } from "@/lib/employees/employees";

export const metadata: Metadata = { title: "Employees · HRMS" };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, key: string): string => (typeof q[key] === "string" ? (q[key] as string) : "");

export default function EmployeesPage(props: PageProps<"/employees">) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <EmployeesContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function EmployeesContent({ searchParams }: { searchParams: Promise<Query> }) {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Femployees&reason=expired");
  if (!auth.permissions.has("employee:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Employees" />
        <NoAccess what="view employees" />
      </div>
    );
  }
  const q = await searchParams;
  const rawStatus = one(q, "status");
  const status = rawStatus === "EXITED" || rawStatus === "ALL" ? rawStatus : "ACTIVE";
  const search = one(q, "q").trim();
  const outletId = one(q, "outlet");
  const canManage = auth.permissions.has("employee:manage");
  const rt = getAuthRuntime();
  const [employees, structure] = await Promise.all([listEmployees(rt.db, auth, { status, q: search, outletId }), listStructure(rt.db, auth)]);
  const filtered = status !== "ACTIVE" || search !== "" || outletId !== "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        description="The people who work for your organisation."
        actions={
          canManage && (
            <Button asChild>
              <Link href="/employees/new">
                <Plus aria-hidden />
                Add employee
              </Link>
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter employees">
          <div className="space-y-1">
            <label htmlFor="emp-q" className="block text-xs text-fg-muted">Search</label>
            <Input id="emp-q" name="q" defaultValue={search} placeholder="Name, code or email" maxLength={100} className="w-56" />
          </div>
          <div className="space-y-1">
            <label htmlFor="emp-status" className="block text-xs text-fg-muted">Status</label>
            <Select id="emp-status" name="status" defaultValue={status} className="w-32">
              <option value="ACTIVE">Active</option>
              <option value="EXITED">Left</option>
              <option value="ALL">All</option>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="emp-outlet" className="block text-xs text-fg-muted">Outlet</label>
            <Select id="emp-outlet" name="outlet" defaultValue={outletId} className="w-44">
              <option value="">All outlets</option>
              {structure.outlet.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">Show</Button>
          {filtered && (
            <Button variant="ghost" asChild>
              <Link href="/employees">Clear</Link>
            </Button>
          )}
        </form>
        <Link href="/employees/structure" className="text-[13px] text-accent-fg hover:underline">
          Outlets, departments and designations
        </Link>
      </div>

      <Card>
        {employees.length === 0 ? (
          <EmptyState
            icon={Users}
            title={filtered ? "No employees match" : "No employees yet"}
            description={filtered ? "Try a different search or filter." : canManage ? "Add your first employee to get started." : "Employees appear here once HR adds them."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Code</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Designation</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Outlet</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Manager</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Login</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {employees.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-muted/60">
                    <td className="tabular px-5 py-3 text-fg-muted">{e.employeeCode}</td>
                    <td className="px-3 py-3">
                      <Link href={`/employees/${e.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {e.fullName}
                      </Link>
                      {e.status === "EXITED" && (
                        <span className="ml-2">
                          <EmployeeStatusBadge status="EXITED" exitedOn={null} />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-fg-muted">{e.designation ?? "—"}</td>
                    <td className="px-3 py-3 text-fg-muted">{e.outlet ?? "—"}</td>
                    <td className="px-3 py-3 text-fg-muted">{e.manager ?? "—"}</td>
                    <td className="px-5 py-3 text-right">
                      {e.hasAccount ? (
                        <span title="Has a login" className="inline-flex text-success">
                          <KeyRound className="size-4" aria-hidden />
                          <span className="sr-only">Has a login</span>
                        </span>
                      ) : (
                        <span className="text-fg-subtle" aria-label="No login">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading employees">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-96" />
    </div>
  );
}
