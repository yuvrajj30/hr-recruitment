import { Download } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { ReportKind, ReportPeriod } from "@/lib/reports/rules";

// Server components shared by the report pages. They render plain figures only (no data reaches client code).

export const REPORT_TITLES: Record<ReportKind, { title: string; description: string }> = {
  headcount: { title: "Headcount", description: "Who is employed, who joined and who left." },
  attendance: { title: "Attendance", description: "Planned shifts against the time people actually worked." },
  leave: { title: "Leave", description: "Balances for the year, and leave taken." },
  hiring: { title: "Hiring", description: "Applications and how they moved, per job. Counts only, no names." },
  tasks: { title: "Tasks", description: "Tasks due in the period: approved, on time, overdue and ratings." },
};

export function ReportsNav({ active }: { active: ReportKind | "overview" }) {
  const items: { key: ReportKind | "overview"; href: string; label: string }[] = [
    { key: "overview", href: "/reports", label: "Overview" },
    ...(Object.keys(REPORT_TITLES) as ReportKind[]).map((k) => ({ key: k, href: `/reports/${k}`, label: REPORT_TITLES[k].title })),
  ];
  return (
    <nav aria-label="Reports" className="flex flex-wrap gap-2 text-[13px]">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.key === active ? "page" : undefined}
          className={`rounded-md border px-3 py-1.5 font-medium ${i.key === active ? "border-accent bg-accent-soft text-accent-fg" : "border-border-strong text-fg hover:bg-surface-muted"}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export type FilterValues = { period: ReportPeriod; outletId: string; year: number };

// A plain GET form: the filters live in the address, so a report can be bookmarked or shared with a colleague.
export function ReportFilters({
  kind, values, outlets, withOutlet, withYear, errors,
}: {
  kind: ReportKind; values: FilterValues; outlets: { id: string; name: string; isActive: boolean }[];
  withOutlet: boolean; withYear: boolean; errors: Record<string, string>;
}) {
  const csv = new URLSearchParams({ from: values.period.from, to: values.period.to });
  if (withOutlet && values.outletId) csv.set("outlet", values.outletId);
  if (withYear) csv.set("year", String(values.year));
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <div className="space-y-2">
      <form method="get" action={`/reports/${kind}`} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="r-from">From</Label>
          <Input id="r-from" name="from" type="date" defaultValue={values.period.from} aria-invalid={Boolean(errors.from)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-to">To</Label>
          <Input id="r-to" name="to" type="date" defaultValue={values.period.to} aria-invalid={Boolean(errors.to)} className="w-40" />
        </div>
        {withYear && (
          <div className="space-y-1">
            <Label htmlFor="r-year">Balances for</Label>
            <Input id="r-year" name="year" type="number" min={2000} defaultValue={values.year} className="w-24" />
          </div>
        )}
        {withOutlet && (
          <div className="space-y-1">
            <Label htmlFor="r-outlet">Outlet</Label>
            <Select id="r-outlet" name="outlet" defaultValue={values.outletId}>
              <option value="">All outlets</option>
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.isActive ? "" : " (closed)"}
                </option>
              ))}
            </Select>
          </div>
        )}
        <Button type="submit" variant="secondary">
          Show
        </Button>
        {!hasErrors && (
          <Button asChild variant="ghost">
            {/* A download, not a page: the browser saves the file. */}
            <a href={`/api/reports/${kind}?${csv.toString()}`} download>
              <Download aria-hidden />
              Download CSV
            </a>
          </Button>
        )}
      </form>
      {hasErrors && (
        <p role="alert" className="text-[13px] text-danger">
          {Object.values(errors).join(" ")} Showing the current month instead.
        </p>
      )}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular text-fg">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>;
}

export type Column<T> = { label: string; cell: (row: T) => ReactNode; numeric?: boolean };

export function ReportTable<T>({ rows, columns, rowKey, minWidth = 640 }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]" style={{ minWidth }}>
        <thead className="border-b border-border text-xs text-fg-muted">
          <tr>
            {columns.map((c, i) => (
              <th key={c.label} scope="col" className={`py-2.5 font-medium ${i === 0 ? "px-5" : i === columns.length - 1 ? "pl-3 pr-5" : "px-3"} ${c.numeric ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c, i) => (
                <td key={c.label} className={`py-2.5 ${i === 0 ? "px-5 font-medium text-fg" : i === columns.length - 1 ? "pl-3 pr-5" : "px-3"} ${c.numeric ? "text-right tabular" : ""}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "Asha (E1)" style first column.
export function PersonCell({ name, code }: { name: string; code: string }) {
  return (
    <>
      {name}
      {code && <span className="ml-1.5 text-xs font-normal text-fg-subtle">{code}</span>}
    </>
  );
}
