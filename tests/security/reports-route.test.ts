// The CSV download route (src/app/api/reports/[report]/route.ts), with the session and the report service replaced by
// test doubles: who may download, what is refused before anything is read, and the response headers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ current: null as null | { permissions: Set<string> } }));
const calls = vi.hoisted(() => ({ timezone: 0, exports: [] as unknown[] }));

vi.mock("@/lib/auth/server-session", () => ({ getCurrentAuth: async () => auth.current }));
vi.mock("@/lib/auth/runtime", () => ({
  getAuthRuntime: () => ({ db: {}, now: () => new Date("2026-11-27T06:00:00Z"), trustedProxyHops: 0, clientIpHeader: null }),
}));
vi.mock("@/lib/attendance/attendance", () => ({
  attendanceTimezone: async () => {
    calls.timezone++;
    return "Asia/Kolkata";
  },
}));
vi.mock("@/lib/reports/reports", () => ({
  exportReportCsv: async (_deps: unknown, _ctx: unknown, kind: string, filters: unknown) => {
    calls.exports.push({ kind, filters });
    return { filename: `${kind}-x.csv`, csv: "﻿A\r\n" };
  },
}));

const { GET } = await import("@/app/api/reports/[report]/route");
const call = (report: string, query = "") =>
  GET(new Request(`http://localhost/api/reports/${report}${query}`), { params: Promise.resolve({ report }) } as never);

describe("report CSV route", () => {
  beforeEach(() => {
    auth.current = null;
    calls.timezone = 0;
    calls.exports = [];
  });

  it("answers 404 for an unknown report and 401 without a session, reading nothing", async () => {
    expect((await call("salaries")).status).toBe(404);
    expect((await call("attendance")).status).toBe(401);
    expect(calls).toEqual({ timezone: 0, exports: [] });
  });

  it("refuses an Employee (no report:read) before reading anything", async () => {
    auth.current = { permissions: new Set(["self:attendance_read", "self:leave_read"]) };
    expect((await call("attendance")).status).toBe(403);
    expect(calls).toEqual({ timezone: 0, exports: [] });
  });

  it("refuses a bad period with 400 and exports nothing", async () => {
    auth.current = { permissions: new Set(["report:read"]) };
    expect((await call("attendance", "?from=2026-10-31&to=2026-10-01")).status).toBe(400);
    expect(calls.exports).toEqual([]);
  });

  it("sends the file as a private, uncached attachment with the filters it was asked for", async () => {
    auth.current = { permissions: new Set(["report:read"]) };
    const outlet = "3f2b8c1e-1d2a-4c5b-9e8f-0a1b2c3d4e5f";
    const res = await call("leave", `?from=2026-10-01&to=2026-10-31&outlet=${outlet}&year=2026`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="leave-x.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(calls.exports).toEqual([{ kind: "leave", filters: { period: { from: "2026-10-01", to: "2026-10-31" }, outletId: outlet, year: 2026 } }]);
  });
});
