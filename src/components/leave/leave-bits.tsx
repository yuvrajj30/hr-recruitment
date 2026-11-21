import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/recruitment/labels";
import { LEAVE_STATUS_LABELS, type LeaveRequestStatus } from "@/lib/leave/rules";

// Display pieces shared by the leave pages (server-rendered). Days arrive as "YYYY-MM-DD" text.

const STATUS_TONES = { PENDING: "warning", APPROVED: "success", REJECTED: "neutral", WITHDRAWN: "neutral", CANCELLED: "neutral" } as const;

export function LeaveStatusBadge({ status }: { status: LeaveRequestStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{LEAVE_STATUS_LABELS[status]}</Badge>;
}

// "12 Nov 2026" for a plain calendar day (no time zone shift: the text is the day).
export const dayLabel = (day: string): string => formatDate(new Date(`${day}T00:00:00Z`), "UTC");

// "12 Nov 2026 to 14 Nov 2026"; half days get a ½ mark next to the day they apply to.
export function leaveRange(start: string, end: string, startHalf: boolean, endHalf: boolean): string {
  if (start === end) return `${dayLabel(start)}${startHalf || endHalf ? " (½)" : ""}`;
  return `${dayLabel(start)}${startHalf ? " (½)" : ""} to ${dayLabel(end)}${endHalf ? " (½)" : ""}`;
}

// Links between the leave screens (callers decide who sees them: canSelf = self:leave_read; the rest need leave:read).
export function LeaveNav({ active, canSelf }: { active?: "requests" | "calendar" | "setup"; canSelf: boolean }) {
  const items = [
    ...(canSelf ? [{ key: "me", href: "/leave", label: "My leave" }] : []),
    { key: "requests", href: "/leave/requests", label: "Requests" },
    { key: "calendar", href: "/leave/calendar", label: "Who is off" },
    { key: "setup", href: "/leave/setup", label: "Set-up" },
  ];
  return (
    <nav aria-label="Leave" className="flex flex-wrap gap-2 text-[13px]">
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
