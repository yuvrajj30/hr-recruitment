import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav } from "@/components/attendance/attendance-bits";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, getShiftHistory, type ShiftHistoryItem } from "@/lib/attendance/attendance";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Shift history · HRMS" };

const KIND_LABELS = { CREATED: "Created", CHANGED: "Changed", CANCELLED: "Cancelled" } as const;
const KIND_TONES = { CREATED: "success", CHANGED: "accent", CANCELLED: "danger" } as const;

const FIELDS: { key: string; label: string }[] = [
  { key: "starts_at", label: "Starts" },
  { key: "ends_at", label: "Ends" },
  { key: "outlet_id", label: "Outlet" },
  { key: "break_minutes", label: "Break (minutes)" },
  { key: "note", label: "Note" },
  { key: "status", label: "Status" },
  { key: "cancel_reason", label: "Cancel reason" },
];

export default function ShiftPage(props: PageProps<"/attendance/shifts/[shiftId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ShiftContent params={props.params} />
    </Suspense>
  );
}

function show(key: string, value: unknown, tz: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "outlet_id") return "changed";
  if ((key === "starts_at" || key === "ends_at") && typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : formatDateTime(d, tz);
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—";
}

function differences(item: ShiftHistoryItem, tz: string): { label: string; before: string; after: string }[] {
  if (!item.before) return [];
  const out: { label: string; before: string; after: string }[] = [];
  for (const f of FIELDS) {
    const b = item.before[f.key];
    const a = item.after[f.key];
    if (b === a || (b == null && a == null)) continue;
    out.push({ label: f.label, before: f.key === "outlet_id" ? "previous outlet" : show(f.key, b, tz), after: f.key === "outlet_id" ? "changed" : show(f.key, a, tz) });
  }
  return out;
}

async function ShiftContent({ params }: { params: Promise<{ shiftId: string }> }) {
  const { shiftId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/attendance/shifts/${shiftId}`)}&reason=expired`);
  if (!auth.permissions.has("attendance:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Shift history" />
        <NoAccess what="view shift history" />
      </div>
    );
  }
  const rt = getAuthRuntime();
  let history: ShiftHistoryItem[];
  try {
    history = await getShiftHistory(rt.db, auth, shiftId);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const tz = await attendanceTimezone(rt.db, auth);

  return (
    <div className="space-y-6">
      <PageHeader title="Shift history" description="Every change to this shift, oldest first. Nobody can edit this record." />
      <AttendanceNav active="rota" canSelf={auth.permissions.has("self:attendance_read")} />
      <Link href="/attendance/rota" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-fg hover:underline">
        <ArrowLeft className="size-4" aria-hidden />
        Back to the rota
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        {history.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-fg-muted">No history was recorded for this shift.</p>
        ) : (
          <ol className="divide-y divide-border">
            {history.map((item, i) => {
              const diffs = differences(item, tz);
              return (
                <li key={i} className="space-y-1.5 px-5 py-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Badge>
                    <span className="tabular text-fg">{formatDateTime(item.at, tz)}</span>
                    <span className="text-fg-muted">by {item.system ? "System (standard rota)" : (item.by ?? "Unknown")}</span>
                  </div>
                  {diffs.length > 0 && (
                    <ul className="space-y-0.5 text-fg-muted">
                      {diffs.map((d) => (
                        <li key={d.label}>
                          <span className="font-medium text-fg">{d.label}:</span> {d.before} → {d.after}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading shift history">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64" />
    </div>
  );
}
