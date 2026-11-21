import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AttendanceNav, Detail, FlagBadges, RecordStatusBadge, timeRange } from "@/components/attendance/attendance-bits";
import { CorrectRecordForm, VoidRecordForm } from "@/components/attendance/hr-forms";
import { CorrectionRequestForm } from "@/components/attendance/request-forms";
import { NoAccess } from "@/components/recruitment/job-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { attendanceTimezone, getRecord, getRota, type RecordDetail } from "@/lib/attendance/attendance";
import { ATTENDANCE_LIMITS, CHANGE_LABELS, dayRange, formatMinutes, localDay, localTime, SOURCE_LABELS } from "@/lib/attendance/rules";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { formatDate, formatDateTime } from "@/lib/recruitment/labels";

export const metadata: Metadata = { title: "Attendance record · HRMS" };

export default function RecordPage(props: PageProps<"/attendance/records/[recordId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RecordContent params={props.params} />
    </Suspense>
  );
}

async function RecordContent({ params }: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await params;
  const auth = await getCurrentAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(`/attendance/records/${recordId}`)}&reason=expired`);
  const canRead = auth.permissions.has("attendance:read");
  if (!canRead && !auth.permissions.has("self:attendance_read")) return <NoAccess what="view attendance records" />;

  const rt = getAuthRuntime();
  const now = new Date();
  let record: RecordDetail;
  try {
    record = await getRecord(rt.db, auth, recordId, now);
  } catch (error) {
    if (error instanceof RecruitmentError && error.code === "not_found") notFound();
    throw error;
  }
  const canManage = auth.permissions.has("attendance:manage");
  const tz = await attendanceTimezone(rt.db, auth);
  const day = localDay(record.clockInAt, tz);
  const editable = record.status !== "VOID";
  // Anyone may ask HR to correct their OWN record (HR staff too: someone else then decides it).
  const canAsk = record.mine && auth.permissions.has("self:attendance_clock") && (record.status === "CLOSED" || record.status === "MISSING_OUT");
  const outlets = canManage ? (await getRota(rt.db, auth, dayRange(day, tz), null)).outlets : [];
  const defaults = {
    day,
    start: localTime(record.clockInAt, tz),
    end: record.clockOutAt ? localTime(record.clockOutAt, tz) : "",
    breakMinutes: record.breakMinutes !== null ? String(record.breakMinutes) : "",
  };
  const outletId = record.outletId && outlets.some((o) => o.id === record.outletId) ? record.outletId : "";

  return (
    <div className="space-y-6">
      <Link href={canRead ? `/attendance/review?day=${day}` : "/attendance"} className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Attendance
      </Link>
      <PageHeader title={record.employeeName} description={`${record.employeeCode} · ${formatDate(record.clockInAt, tz)}`} />
      {canRead && <AttendanceNav canSelf={auth.permissions.has("self:attendance_read")} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Time worked</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
                <Detail label="Status">
                  <RecordStatusBadge status={record.status} />
                </Detail>
                <Detail label="Flags">
                  <FlagBadges flags={record.flags} />
                </Detail>
                <Detail label="Clocked in">
                  {localTime(record.clockInAt, tz)} <span className="font-normal text-fg-muted">({SOURCE_LABELS[record.inSource]})</span>
                </Detail>
                <Detail label="Clocked out">
                  {record.clockOutAt ? localTime(record.clockOutAt, tz) : "—"}{" "}
                  {record.outSource && <span className="font-normal text-fg-muted">({SOURCE_LABELS[record.outSource]})</span>}
                </Detail>
                <Detail label="Worked">{formatMinutes(record.worked)}</Detail>
                <Detail label="Outlet">{record.outlet ?? "—"}</Detail>
                <Detail label="Planned shift">{record.shift ? timeRange(record.shift.startsAt, record.shift.endsAt, tz) : "Not on the rota"}</Detail>
                <Detail label="Break set by HR">{record.breakMinutes !== null ? `${record.breakMinutes} min` : "—"}</Detail>
              </dl>
              <div>
                <h3 className="mb-1 text-[13px] font-medium text-fg">Breaks</h3>
                {record.breaks.length === 0 ? (
                  <p className="text-[13px] text-fg-muted">No breaks recorded.</p>
                ) : (
                  <ul className="space-y-0.5 text-[13px] tabular">
                    {record.breaks.map((b, i) => (
                      <li key={i}>{timeRange(b.startsAt, b.endsAt, tz)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>History</CardTitle>
                <CardDescription>Every change to this record, oldest first. It cannot be edited or deleted.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <ol className="space-y-3 text-[13px]">
                {record.history.map((h, i) => (
                  <li key={i} className="border-l-2 border-border pl-3">
                    <p className="font-medium text-fg">
                      {CHANGE_LABELS[h.kind]}
                      {h.selfEdit && (
                        <Badge tone="accent" className="ml-2">
                          Self-edit
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {formatDateTime(h.at, tz)}
                      {h.by ? ` · ${h.by}` : ""}
                    </p>
                    {h.reason && <p className="text-fg-muted">Reason: {h.reason}</p>}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="self-start">
            <CardHeader>
              <div>
                <CardTitle>Device details</CardTitle>
                <CardDescription>Kept for {ATTENDANCE_LIMITS.deviceRetentionDays} days, then removed.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <dl className="space-y-3 text-[13px]">
                <Detail label="Clock-in address">{record.device.inIp ?? "—"}</Detail>
                <Detail label="Clock-in device">{record.device.inUserAgent ?? "—"}</Detail>
                <Detail label="Clock-out address">{record.device.outIp ?? "—"}</Detail>
                <Detail label="Clock-out device">{record.device.outUserAgent ?? "—"}</Detail>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      {canManage && editable && (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Correct</CardTitle>
                <CardDescription>The change is added to the history with your reason.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <CorrectRecordForm recordId={record.id} endOptional={record.status === "OPEN"} defaults={{ ...defaults, outletId }} outlets={outlets} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Void</CardTitle>
                <CardDescription>Use this when the record should not exist (for example, clocked in by mistake).</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <VoidRecordForm recordId={record.id} />
            </CardBody>
          </Card>
        </>
      )}

      {canAsk && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Ask for a correction</CardTitle>
              <CardDescription>Tell HR what the times should be and why.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <CorrectionRequestForm recordId={record.id} defaults={defaults} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading record">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-96" />
    </div>
  );
}
