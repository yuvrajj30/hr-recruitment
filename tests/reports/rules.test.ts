import { describe, expect, it } from "vitest";
import {
  defaultPeriod, parsePeriod, parseYear, periodRange, readReportQuery, REPORT_LIMITS, summariseAttendance, summariseHeadcount, summariseHiring, summariseTasks, toCsv,
  type AttRecord, type AttShift, type HcEmployee, type HiringApplication, type HiringHistory, type ReportTask, withinLimit,
} from "@/lib/reports/rules";

const TZ = "Asia/Kolkata"; // UTC+05:30, no daylight saving
const at = (local: string) => new Date(`${local}:00+05:30`);

describe("periods", () => {
  it("defaults to the first of this month up to today", () => {
    expect(defaultPeriod("2026-11-27")).toEqual({ from: "2026-11-01", to: "2026-11-27" });
  });

  it("accepts a valid inclusive period and falls back to the default when both are empty", () => {
    expect(parsePeriod({ from: "2026-10-01", to: "2026-10-31" }, "2026-11-27")).toEqual({ ok: true, value: { from: "2026-10-01", to: "2026-10-31" } });
    expect(parsePeriod({}, "2026-11-27")).toEqual({ ok: true, value: { from: "2026-11-01", to: "2026-11-27" } });
    expect(parsePeriod({ from: "2026-11-05", to: "2026-11-05" }, "2026-11-27").ok).toBe(true);
  });

  it("refuses bad dates, a reversed period and one longer than the limit", () => {
    expect(parsePeriod({ from: "2026-02-30", to: "2026-03-01" }, "2026-11-27")).toEqual({ ok: false, errors: { from: "Enter a valid start date." } });
    expect(parsePeriod({ from: "2026-03-01", to: "nope" }, "2026-11-27")).toEqual({ ok: false, errors: { to: "Enter a valid end date." } });
    expect(parsePeriod({ from: "2026-03-02", to: "2026-03-01" }, "2026-11-27")).toEqual({ ok: false, errors: { to: "The end date cannot be before the start date." } });
    expect(parsePeriod({ from: "2025-01-01", to: "2026-01-02" }, "2026-11-27")).toEqual({ ok: false, errors: { to: `Choose a period of at most ${REPORT_LIMITS.maxDays} days.` } });
    expect(parsePeriod({ from: ["2026-01-01"], to: "2026-01-02" }, "2026-11-27").ok).toBe(false);
  });

  it("turns a period into [start of first day, start of the day after the last) in the organisation's time zone", () => {
    expect(periodRange({ from: "2026-11-01", to: "2026-11-30" }, TZ)).toEqual({ start: at("2026-11-01T00:00"), end: at("2026-12-01T00:00") });
  });

  it("reads a year, defaulting to this one and refusing nonsense", () => {
    expect(parseYear(undefined, "2026-11-27")).toBe(2026);
    expect(parseYear("2025", "2026-11-27")).toBe(2025);
    expect(parseYear("2027", "2026-11-27")).toBe(2027);
    expect(parseYear("2028", "2026-11-27")).toBe(2026);
    expect(parseYear("1999", "2026-11-27")).toBe(2026);
    expect(parseYear("20x5", "2026-11-27")).toBe(2026);
  });
});

describe("headcount", () => {
  const e = (id: string, joinedOn: string, exitedOn: string | null, extra: Partial<HcEmployee> = {}): HcEmployee => ({
    id, joinedOn, exitedOn, employmentType: "FULL_TIME", outlet: "Main", department: "Kitchen", ...extra,
  });
  const people = [
    e("a", "2025-01-01", null),
    e("b", "2025-06-01", "2026-11-10", { outlet: "Second" }), // left during the period (last working day 10 Nov)
    e("c", "2026-11-15", null, { employmentType: "PART_TIME", department: null }), // joined during the period
    e("d", "2024-01-01", "2026-10-31"), // left before the period
    e("f", "2026-12-01", null), // joins after the period
  ];

  it("counts people on the first and the last day, joiners, leavers and turnover", () => {
    const r = summariseHeadcount(people, { from: "2026-11-01", to: "2026-11-30" });
    expect(r.atStart).toBe(2); // a, b
    expect(r.atEnd).toBe(2); // a, c
    expect(r.joiners).toBe(1);
    expect(r.leavers).toBe(1);
    expect(r.turnoverPercent).toBe(50); // 1 / ((2 + 2) / 2)
  });

  it("splits the people at the end by outlet, department and employment type", () => {
    const r = summariseHeadcount(people, { from: "2026-11-01", to: "2026-11-30" });
    expect(r.byOutlet).toEqual([{ name: "Main", count: 2 }]);
    expect(r.byDepartment).toEqual([{ name: "Kitchen", count: 1 }, { name: "No department", count: 1 }]);
    expect(r.byType).toEqual([{ name: "Full-time", count: 1 }, { name: "Part-time", count: 1 }]);
  });

  it("has no turnover when nobody was employed", () => {
    expect(summariseHeadcount([], { from: "2026-11-01", to: "2026-11-30" }).turnoverPercent).toBeNull();
  });
});

describe("attendance", () => {
  const now = at("2026-11-20T12:00");
  const people = new Map([["p1", { name: "Asha", code: "E1" }], ["p2", { name: "Bilal", code: "E2" }]]);
  const shift = (id: string, employeeId: string, start: string, end: string, records: AttShift["records"] = [], status: AttShift["status"] = "PLANNED"): AttShift => ({
    id, employeeId, startsAt: at(start), endsAt: at(end), status, breakMinutes: 30, records,
  });
  const rec = (employeeId: string, shiftId: string | null, inAt: string, outAt: string | null, status: AttRecord["status"] = "CLOSED", breakMinutes: number | null = 30): AttRecord => {
    const s = shifts.find((x) => x.id === shiftId);
    return {
      employeeId, shiftId, status, clockInAt: at(inAt), clockOutAt: outAt ? at(outAt) : null, breakMinutes, breaks: [],
      shift: s ? { startsAt: s.startsAt, endsAt: s.endsAt, breakMinutes: s.breakMinutes } : null,
    };
  };
  const shifts: AttShift[] = [
    shift("s1", "p1", "2026-11-17T09:00", "2026-11-17T17:00", [{ status: "CLOSED" }]), // on time, full day
    shift("s2", "p1", "2026-11-18T09:00", "2026-11-18T17:00", [{ status: "CLOSED" }]), // 20 minutes late, left 30 minutes early
    shift("s3", "p1", "2026-11-19T09:00", "2026-11-19T17:00"), // missed
    shift("s4", "p2", "2026-11-18T09:00", "2026-11-18T17:00"), // no record, but approved leave that day
    shift("s5", "p2", "2026-11-19T09:00", "2026-11-19T17:00", [{ status: "VOID" }]), // only a voided record: missed
    shift("s6", "p2", "2026-11-21T09:00", "2026-11-21T17:00"), // tomorrow: upcoming
    shift("s7", "p1", "2026-11-16T09:00", "2026-11-16T17:00", [], "CANCELLED"), // cancelled: not counted
  ];
  const records: AttRecord[] = [
    rec("p1", "s1", "2026-11-17T09:03", "2026-11-17T17:00"),
    rec("p1", "s2", "2026-11-18T09:20", "2026-11-18T16:30"),
    rec("p1", null, "2026-11-20T08:00", null, "MISSING_OUT", null), // unplanned, never clocked out
    rec("p2", "s5", "2026-11-19T09:00", "2026-11-19T17:00", "VOID"),
  ];
  const leaveDays = new Set(["p2|2026-11-18"]);

  it("summarises planned, attended, missed, on-leave and upcoming shifts per person", () => {
    const rows = summariseAttendance(people, shifts, records, leaveDays, TZ, now);
    const asha = rows.find((r) => r.employeeId === "p1")!;
    const bilal = rows.find((r) => r.employeeId === "p2")!;
    expect(asha).toMatchObject({ name: "Asha", code: "E1", planned: 3, attended: 2, missed: 1, onLeave: 0, upcoming: 0 });
    expect(bilal).toMatchObject({ planned: 3, attended: 0, missed: 1, onLeave: 1, upcoming: 1 });
  });

  it("counts late arrivals (beyond the grace period), early leaves, missing clock-outs, unplanned records and worked time", () => {
    const asha = summariseAttendance(people, shifts, records, leaveDays, TZ, now).find((r) => r.employeeId === "p1")!;
    expect(asha.late).toBe(1); // 09:03 is within the grace period
    expect(asha.lateMinutes).toBe(20);
    expect(asha.early).toBe(1);
    expect(asha.missingOut).toBe(1);
    expect(asha.unplanned).toBe(1);
    expect(asha.workedMinutes).toBe((477 - 30) + (430 - 30)); // 09:03-17:00 and 09:20-16:30, minus breaks
  });

  it("ignores voided records completely and sorts people by name", () => {
    const rows = summariseAttendance(people, shifts, records, leaveDays, TZ, now);
    expect(rows.map((r) => r.name)).toEqual(["Asha", "Bilal"]);
    expect(rows[1]!.workedMinutes).toBe(0);
    expect(rows[1]!.late).toBe(0);
  });

  it("shows a person seen only in the data but missing from the list under a placeholder name", () => {
    const rows = summariseAttendance(new Map(), [shifts[0]!], [records[0]!], new Set(), TZ, now);
    expect(rows).toEqual([expect.objectContaining({ employeeId: "p1", name: "Unknown employee", code: "" })]);
  });
});

describe("tasks", () => {
  const now = at("2026-11-20T12:00");
  const people = new Map([["p1", { name: "Asha", code: "E1" }], ["p2", { name: "Bilal", code: "E2" }]]);
  const t = (ownerEmployeeId: string, status: ReportTask["status"], dueOn: string, extra: Partial<ReportTask> = {}): ReportTask => ({
    ownerEmployeeId, status, dueOn, dueTime: null, submittedAt: null, rating: null, changesRequested: 0, ...extra,
  });
  const tasks: ReportTask[] = [
    t("p1", "APPROVED", "2026-11-18", { submittedAt: at("2026-11-18T23:00"), rating: 5 }), // by the end of the due day: on time
    t("p1", "APPROVED", "2026-11-18", { dueTime: "10:00", submittedAt: at("2026-11-18T10:30"), rating: 2, changesRequested: 1 }), // late
    t("p1", "IN_PROGRESS", "2026-11-19"), // overdue
    t("p1", "SUBMITTED", "2026-11-19", { submittedAt: at("2026-11-20T09:00") }), // waiting for HR: not overdue
    t("p2", "ASSIGNED", "2026-11-25"), // not due yet
    t("p2", "CANCELLED", "2026-11-18"), // not counted
    t("p2", "APPROVED", "2026-11-17", { submittedAt: at("2026-11-17T08:00") }), // approved, no rating
  ];

  it("summarises assigned, approved, on-time, overdue, changes requested and average rating per person", () => {
    const rows = summariseTasks(people, tasks, TZ, now);
    expect(rows.find((r) => r.employeeId === "p1")).toMatchObject({ assigned: 4, approved: 2, onTime: 1, overdue: 1, changesRequested: 1, averageRating: 3.5,
      ratingCount: 2, ratingSum: 7 });
    expect(rows.find((r) => r.employeeId === "p2")).toMatchObject({ assigned: 2, approved: 1, onTime: 1, overdue: 0, changesRequested: 0, averageRating: null });
  });
});

describe("hiring", () => {
  const range = { start: at("2026-11-01T00:00"), end: at("2026-12-01T00:00") };
  const jobs = [{ id: "j1", title: "Barista" }, { id: "j2", title: "Chef" }];
  const apps: HiringApplication[] = [
    { jobId: "j1", stage: "APPLIED", appliedAt: at("2026-11-02T10:00") },
    { jobId: "j1", stage: "JOINED", appliedAt: at("2026-10-20T10:00") }, // applied before the period
    { jobId: "j1", stage: "REJECTED", appliedAt: at("2026-11-05T10:00") },
    { jobId: "j2", stage: "INTERVIEW_SCHEDULED", appliedAt: at("2026-12-02T10:00") }, // after the period
  ];
  const history: HiringHistory[] = [
    { jobId: "j1", applicationId: "a1", toStage: "INTERVIEW_SCHEDULED", createdAt: at("2026-11-03T10:00") },
    { jobId: "j1", applicationId: "a2", toStage: "SELECTED", createdAt: at("2026-11-04T10:00") },
    { jobId: "j1", applicationId: "a2", toStage: "OFFER_ACCEPTED", createdAt: at("2026-11-06T10:00") },
    { jobId: "j1", applicationId: "a2", toStage: "JOINED", createdAt: at("2026-11-10T10:00") },
    { jobId: "j1", applicationId: "a3", toStage: "REJECTED", createdAt: at("2026-11-07T10:00") },
    { jobId: "j1", applicationId: "a4", toStage: "INTERVIEW_SCHEDULED", createdAt: at("2026-10-25T10:00") }, // before the period
  ];

  it("counts, per job, applications received and stage moves within the period", () => {
    const r = summariseHiring(jobs, apps, history, range);
    expect(r.jobs).toEqual([
      { jobId: "j1", title: "Barista", received: 2, interviewing: 1, selected: 1, offerAccepted: 1, joined: 1, rejected: 1 },
      { jobId: "j2", title: "Chef", received: 0, interviewing: 0, selected: 0, offerAccepted: 0, joined: 0, rejected: 0 },
    ]);
  });

  it("counts an application once per stage even when it moved into that stage twice (a rescheduled interview)", () => {
    const twice: HiringHistory[] = [...history, { jobId: "j1", applicationId: "a1", toStage: "INTERVIEW_SCHEDULED", createdAt: at("2026-11-08T10:00") }];
    expect(summariseHiring(jobs, apps, twice, range).jobs[0]!.interviewing).toBe(1);
  });

  it("gives the current pipeline by stage, in stage order, without people's details", () => {
    const r = summariseHiring(jobs, apps, history, range);
    expect(r.pipeline).toEqual([
      { stage: "APPLIED", label: expect.any(String), count: 1 },
      { stage: "INTERVIEW_SCHEDULED", label: expect.any(String), count: 1 },
      { stage: "JOINED", label: expect.any(String), count: 1 },
      { stage: "REJECTED", label: expect.any(String), count: 1 },
    ]);
  });
});

describe("CSV", () => {
  it("writes a header and rows with CRLF line ends and a byte-order mark for spreadsheets", () => {
    expect(toCsv(["Name", "Hours"], [["Asha", 7.5], ["Bilal", null]])).toBe("﻿Name,Hours\r\nAsha,7.5\r\nBilal,\r\n");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(toCsv(["A"], [['He said "hi", then left\nlate']])).toBe('﻿A\r\n"He said ""hi"", then left\nlate"\r\n');
  });

  it("stops spreadsheet formulas in text cells, but leaves real numbers alone", () => {
    const csv = toCsv(["A", "B", "C", "D", "E", "F"], [["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", -2]]);
    expect(csv).toBe("﻿A,B,C,D,E,F\r\n'=1+1,'+cmd,'-2,'@SUM(A1),'\tx,-2\r\n");
  });
});

describe("report filters in the address", () => {
  const today = "2026-11-27";
  const outlet = "3f2b8c1e-1d2a-4c5b-9e8f-0a1b2c3d4e5f";

  it("reads a period, an outlet and a year", () => {
    expect(readReportQuery({ from: "2026-10-01", to: "2026-10-31", outlet, year: "2025" }, today))
      .toEqual({ period: { from: "2026-10-01", to: "2026-10-31" }, outletId: outlet, year: 2025, errors: {} });
  });

  it("falls back to this month and says why when the period is wrong, and ignores a bad outlet or repeated values", () => {
    expect(readReportQuery({ from: "2026-10-31", to: "2026-10-01", outlet: "1 OR 1=1" }, today))
      .toEqual({ period: { from: "2026-11-01", to: "2026-11-27" }, outletId: null, year: 2026, errors: { to: "The end date cannot be before the start date." } });
    expect(readReportQuery({ from: ["2026-10-01", "2026-10-02"], to: "2026-10-31", outlet: [outlet, outlet] }, today))
      .toMatchObject({ period: { from: "2026-11-01", to: "2026-11-27" }, outletId: null, errors: { from: "Enter a valid start date." } });
    expect(readReportQuery({}, today)).toEqual({ period: { from: "2026-11-01", to: "2026-11-27" }, outletId: null, year: 2026, errors: {} });
  });
});

describe("row limit", () => {
  it("passes reads up to the limit and refuses one more, never cutting rows off", () => {
    expect(withinLimit([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(() => withinLimit([1, 2, 3, 4], 3)).toThrow("report_too_large");
    expect(REPORT_LIMITS.maxRows).toBe(20_000);
  });
});
