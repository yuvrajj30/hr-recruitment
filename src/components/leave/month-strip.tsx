import Link from "next/link";
import { addDays } from "@/lib/attendance/rules";
import type { WhoIsOffEntry } from "@/lib/leave/leave";

// The other bold element: one row per person, one cell per day. Approved leave is solid, waiting leave a dashed
// outline, half days half filled. No notes are shown (the service returns none).

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export type StripPerson = { employeeId: string; name: string; code: string; entries: WhoIsOffEntry[] };

function cellOf(entries: WhoIsOffEntry[], day: string): { entry: WhoIsOffEntry; half: boolean } | null {
  // An approved entry wins over a waiting one on the same day.
  const hits = entries.filter((e) => e.start <= day && day <= e.end).sort((a, b) => (a.status === b.status ? 0 : a.status === "APPROVED" ? -1 : 1));
  const entry = hits[0];
  if (!entry) return null;
  const first = entry.start === day;
  const last = entry.end === day;
  const half = first && last ? entry.startHalf || entry.endHalf : (first && entry.startHalf) || (last && entry.endHalf);
  return { entry, half };
}

export function MonthStrip({ first, last, today, people, holidays }: { first: string; last: string; today: string; people: StripPerson[]; holidays: Record<string, string> }) {
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-0 text-[11px]">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 min-w-40 border-b border-border bg-surface px-5 py-2 text-left text-xs font-medium text-fg-muted">
              Person
            </th>
            {days.map((d) => {
              const holiday = holidays[d];
              const isToday = d === today;
              return (
                <th
                  key={d}
                  scope="col"
                  title={holiday ?? undefined}
                  className={`w-7 min-w-7 border-b border-border px-0 py-1.5 text-center font-normal tabular ${isToday ? "bg-accent-soft font-semibold text-accent-fg" : holiday ? "bg-surface-muted text-fg" : "text-fg-muted"}`}
                >
                  <span className="block">{Number(d.slice(8))}</span>
                  <span className="block text-[10px]">{WEEKDAYS[weekday(d)]}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.employeeId}>
              <th scope="row" className="sticky left-0 z-10 min-w-40 border-b border-border bg-surface px-5 py-1.5 text-left text-[13px] font-normal">
                <Link href={`/leave/employees/${p.employeeId}`} className="font-medium text-accent-fg hover:underline">
                  {p.name}
                </Link>
                <span className="ml-1.5 text-xs text-fg-muted">{p.code}</span>
              </th>
              {days.map((d) => {
                const c = cellOf(p.entries, d);
                const holiday = holidays[d];
                const base = `border-b border-border p-0.5 ${d === today ? "bg-accent-soft/60" : holiday ? "bg-surface-muted" : ""}`;
                if (!c) return <td key={d} className={base} title={holiday ?? undefined} />;
                const waiting = c.entry.status === "PENDING";
                const title = `${c.entry.typeCode}, ${waiting ? "waiting for approval" : "approved"}${c.half ? ", half day" : ""}`;
                const fill = waiting ? "border border-dashed border-accent bg-accent-soft" : "bg-accent";
                return (
                  <td key={d} className={base} title={title}>
                    <span className={`relative block h-5 w-full overflow-hidden rounded-sm ${waiting ? "border border-dashed border-accent" : "bg-surface-muted"}`}>
                      <span className={`absolute inset-y-0 left-0 ${c.half ? "w-1/2" : "w-full"} ${fill}`} />
                      <span className="sr-only">{title}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StripLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-fg-muted" aria-label="Legend">
      <li className="flex items-center gap-1.5">
        <span className="block h-3 w-5 rounded-sm bg-accent" aria-hidden /> Approved
      </li>
      <li className="flex items-center gap-1.5">
        <span className="block h-3 w-5 rounded-sm border border-dashed border-accent" aria-hidden /> Waiting for approval
      </li>
      <li className="flex items-center gap-1.5">
        <span className="relative block h-3 w-5 overflow-hidden rounded-sm bg-surface-muted" aria-hidden>
          <span className="absolute inset-y-0 left-0 w-1/2 bg-accent" />
        </span>{" "}
        Half day
      </li>
      <li className="flex items-center gap-1.5">
        <span className="block h-3 w-5 rounded-sm border border-border bg-surface-muted" aria-hidden /> Holiday
      </li>
    </ul>
  );
}
