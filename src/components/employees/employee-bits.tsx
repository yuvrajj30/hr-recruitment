import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { EmployeeDetail } from "@/lib/employees/employees";
import { formatDate } from "@/lib/recruitment/labels";

// Small display pieces shared by the employee pages and "My account".

// joinedOn / exitedOn are calendar days (YYYY-MM-DD), not moments: show them as the same day everywhere.
export function formatDay(day: string): string {
  return formatDate(new Date(`${day}T00:00:00Z`), "UTC");
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}

export function EmployeeStatusBadge({ status, exitedOn }: { status: "ACTIVE" | "EXITED"; exitedOn: string | null }) {
  return status === "EXITED" ? <Badge tone="danger">Left{exitedOn ? ` on ${formatDay(exitedOn)}` : ""}</Badge> : <Badge tone="success">Active</Badge>;
}

const dash = (v: string | null) => v ?? "—";

// The assignment history, newest first. `showChangedBy` is for HR only. `showManager` is off on the employee's own
// view: colleagues' records (and so the manager's name) are visible to HR only.
export function AssignmentHistory({ history, timezone, showChangedBy, showManager = true }: { history: EmployeeDetail["history"]; timezone: string; showChangedBy: boolean; showManager?: boolean }) {
  if (history.length === 0) return <p className="text-[13px] text-fg-muted">No history yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="border-b border-border text-xs text-fg-muted">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">From</th>
            <th scope="col" className="px-3 py-2 font-medium">To</th>
            <th scope="col" className="px-3 py-2 font-medium">Outlet</th>
            <th scope="col" className="px-3 py-2 font-medium">Department</th>
            <th scope="col" className="px-3 py-2 font-medium">Designation</th>
            {showManager && <th scope="col" className="px-3 py-2 font-medium">Manager</th>}
            {showChangedBy && <th scope="col" className="py-2 pl-3 font-medium">Changed by</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {history.map((h, i) => (
            <tr key={i}>
              <td className="py-2.5 pr-3 whitespace-nowrap">{formatDate(h.startsAt, timezone)}</td>
              <td className="px-3 py-2.5 whitespace-nowrap">{h.endsAt ? formatDate(h.endsAt, timezone) : <span className="text-success">Current</span>}</td>
              <td className="px-3 py-2.5">{dash(h.outlet)}</td>
              <td className="px-3 py-2.5">{dash(h.department)}</td>
              <td className="px-3 py-2.5">{dash(h.designation)}</td>
              {showManager && <td className="px-3 py-2.5">{dash(h.manager)}</td>}
              {showChangedBy && <td className="py-2.5 pl-3">{dash(h.changedBy)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
