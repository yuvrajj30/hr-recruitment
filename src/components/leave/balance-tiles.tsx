import { formatDays } from "@/lib/leave/rules";

// The one bold element of "My leave": a tile per leave type with a bar of taken, waiting and left days.

export type TileBalance = { typeName: string; year: number; credited: number; taken: number; pending: number; available: number };

const pct = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.max(0, Math.min(100, (part / whole) * 100)));

export function BalanceTile({ b, showYear }: { b: TileBalance; showYear: boolean }) {
  const taken = pct(b.taken, b.credited);
  const waiting = Math.min(pct(b.pending, b.credited), 100 - taken);
  const left = Math.max(0, 100 - taken - waiting);
  return (
    <div className="rounded-[10px] border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="text-[13px] font-medium text-fg">
        {b.typeName}
        {showYear && <span className="ml-1 font-normal text-fg-muted">{b.year}</span>}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular text-fg">{formatDays(b.available)}</p>
      <p className="text-xs text-fg-muted">available</p>
      <div
        className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-muted"
        role="img"
        aria-label={`Credited ${formatDays(b.credited)}, taken ${formatDays(b.taken)}, waiting ${formatDays(b.pending)}`}
      >
        {b.credited > 0 && (
          <>
            <span className="bg-accent" style={{ width: `${taken}%` }} />
            <span className="bg-accent/40" style={{ width: `${waiting}%` }} />
            <span style={{ width: `${left}%` }} />
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        Credited {formatDays(b.credited)}, taken {b.taken}, waiting {b.pending}
      </p>
    </div>
  );
}

export function NoteTile({ title, text, muted }: { title: string; text: string; muted?: boolean }) {
  return (
    <div className={`rounded-[10px] border border-border p-4 ${muted ? "bg-surface-muted" : "bg-surface"}`}>
      <p className="text-[13px] font-medium text-fg">{title}</p>
      <p className="mt-2 text-[13px] text-fg-muted">{text}</p>
    </div>
  );
}
