import { unstable_rethrow } from "next/navigation";
import { writeAudit } from "@/lib/auth/audit";
import { AuthError } from "@/lib/auth/errors";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { attendanceTimezone } from "@/lib/attendance/attendance";
import { localDay } from "@/lib/attendance/rules";
import { errorResponse } from "@/lib/http/responses";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { exportReportCsv } from "@/lib/reports/reports";
import { isReportKind, readReportQuery } from "@/lib/reports/rules";
import { getClientIp } from "@/lib/security/client-ip";
import { logger } from "@/lib/security/logger";

// A report as a CSV file. Same rules as the report pages: a signed-in member with report:read, and row-level security
// limits the rows to their organisation. Every download is audited (the report and its filters, never the figures).
export async function GET(request: Request, ctx: RouteContext<"/api/reports/[report]">) {
  try {
    const { report } = await ctx.params;
    if (!isReportKind(report)) return errorResponse("invalid_request", 404);
    const auth = await getCurrentAuth();
    if (!auth) return errorResponse("unauthorized", 401);
    if (!auth.permissions.has("report:read")) return errorResponse("forbidden", 403);
    const rt = getAuthRuntime();
    const now = rt.now();
    const today = localDay(now, await attendanceTimezone(rt.db, auth));
    const query = readReportQuery(Object.fromEntries(new URL(request.url).searchParams), today);
    if (Object.keys(query.errors).length) return errorResponse("invalid_request", 400);
    const file = await exportReportCsv(
      { db: rt.db, now, writeAudit, client: { ipAddress: getClientIp(request.headers, { hops: rt.trustedProxyHops, header: rt.clientIpHeader }), userAgent: request.headers.get("user-agent") } },
      auth, report, { period: query.period, outletId: query.outletId, year: query.year },
    );
    return new Response(file.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthError) return errorResponse(error.code, error.status);
    if (error instanceof RecruitmentError) return errorResponse("invalid_request", 400);
    logger.error("reports.export_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return errorResponse("server_error", 500);
  }
}
