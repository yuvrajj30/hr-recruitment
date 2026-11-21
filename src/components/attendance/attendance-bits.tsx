import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { type AttendanceStatus, FLAG_LABELS, localTime, type RecordFlag, STATUS_LABELS } from "@/lib/attendance/rules";
import { formatDate } from "@/lib/recruitment/labels";

// Display pieces shared by the attendance pages (server-rendered; no device details here).

const STATUS_TONES = { OPEN: "accent", CLOSED: "success", MISSING_OUT: "warning", VOID: "neutral" } as const;

export function RecordStatusBadge({ status }: { status: AttendanceStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function FlagBadges({ flags }: { flags: RecordFlag[] }) {
  if (flags.length === 0) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={f} tone="warning">
          {FLAG_LABELS[f]}
        </Badge>
      ))}
    </span>
  );
}

// "09:00 – 17:30" (an open end shows "…").
export const timeRange = (start: Date, end: Date | null, timeZone: string): string => `${localTime(start, timeZone)} – ${end ? localTime(end, timeZone) : "…"}`;

// "12 Nov 2026, 09:00 – 17:30"
export const dayTimeRange = (start: Date, end: Date | null, timeZone: string): string => `${formatDate(start, timeZone)}, ${timeRange(start, end, timeZone)}`;

// Links between the attendance screens (HR views only; callers check attendance:read).
export function AttendanceNav({ active, canSelf }: { active?: "review" | "requests" | "rota" | "standards"; canSelf: boolean }) {
  const items = [
    ...(canSelf ? [{ key: "me", href: "/attendance", label: "My attendance" }] : []),
    { key: "review", href: "/attendance/review", label: "Review" },
    { key: "requests", href: "/attendance/requests", label: "Requests" },
    { key: "rota", href: "/attendance/rota", label: "Rota" },
    { key: "standards", href: "/attendance/standards", label: "Standard shifts" },
  ];
  return (
    <nav aria-label="Attendance" className="flex flex-wrap gap-2 text-[13px]">
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

export function Th({ children, className = "px-3" }: { children?: ReactNode; className?: string }) {
  return (
    <th scope="col" className={`${className} py-2.5 font-medium`}>
      {children}
    </th>
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-medium break-words text-fg">{children}</dd>
    </div>
  );
}
