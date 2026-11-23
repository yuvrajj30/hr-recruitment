import { describe, expect, it } from "vitest";
import {
  breakMinutesOf, databaseMessage, dayRange, dbRefusal, formatMinutes, shiftByDays, isAbandoned, isDay, isMissedShift, localDay, minutesLate, parsePeriod,
  parsePeriodInput, parseRequiredReason, parseShiftInput, recordFlags, type RecordLike, weekStart, workedMinutes,
} from "@/lib/attendance/rules";

const IST = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);
const rec = (over: Partial<RecordLike> = {}): RecordLike => ({
  status: "CLOSED", clockInAt: at("2026-11-20T03:30:00Z"), clockOutAt: at("2026-11-20T11:30:00Z"), breakMinutes: null, breaks: [],
  shift: { startsAt: at("2026-11-20T03:30:00Z"), endsAt: at("2026-11-20T11:30:00Z"), breakMinutes: 30 }, ...over,
});
const NOW = at("2026-11-21T06:00:00Z");

describe("worked time", () => {
  it("subtracts recorded breaks, or the break minutes HR set instead", () => {
    const breaks = [{ startsAt: at("2026-11-20T07:00:00Z"), endsAt: at("2026-11-20T07:20:30Z") }, { startsAt: at("2026-11-20T09:00:00Z"), endsAt: at("2026-11-20T09:10:00Z") }];
    expect(breakMinutesOf({ breakMinutes: null, breaks }, NOW)).toBe(30); // 20m30s + 10m, floored once
    expect(workedMinutes(rec({ breaks }), NOW)).toBe(450);
    expect(workedMinutes(rec({ breaks, breakMinutes: 45 }), NOW)).toBe(435);
    expect(breakMinutesOf({ breakMinutes: 0, breaks }, NOW)).toBe(0);
  });
  it("has no worked time until the record is complete", () => {
    for (const status of ["OPEN", "MISSING_OUT", "VOID"] as const) expect(workedMinutes(rec({ status, clockOutAt: status === "VOID" ? at("2026-11-20T11:30:00Z") : null }), NOW)).toBeNull();
  });
  it("counts an open break up to now", () => {
    expect(breakMinutesOf({ breakMinutes: null, breaks: [{ startsAt: at("2026-11-21T05:45:00Z"), endsAt: null }] }, NOW)).toBe(15);
  });
  it("formats minutes", () => {
    expect(formatMinutes(450)).toBe("7h 30m");
    expect(formatMinutes(5)).toBe("5m");
    expect(formatMinutes(null)).toBe("—");
  });
});

describe("flags", () => {
  it("allows five minutes of grace for late arrival and early leaving", () => {
    expect(recordFlags(rec({ clockInAt: at("2026-11-20T03:35:00Z") }), NOW)).toEqual([]);
    expect(recordFlags(rec({ clockInAt: at("2026-11-20T03:35:01Z") }), NOW)).toEqual(["late"]);
    expect(minutesLate(rec({ clockInAt: at("2026-11-20T03:52:00Z") }))).toBe(22);
    expect(recordFlags(rec({ clockOutAt: at("2026-11-20T11:24:00Z") }), NOW)).toEqual(["early"]);
  });
  it("flags work without a shift, records left open, and nothing on void records", () => {
    expect(recordFlags(rec({ shift: null }), NOW)).toEqual(["unplanned"]);
    expect(recordFlags(rec({ status: "MISSING_OUT", clockOutAt: null }), NOW)).toEqual(["missing_out"]);
    expect(recordFlags(rec({ status: "VOID", shift: null }), NOW)).toEqual([]);
  });
  it("treats an open record as left behind after 20 hours, or 4 hours after its shift ended", () => {
    const open = (inAt: string, shiftEnd: string | null) => ({ status: "OPEN" as const, clockInAt: at(inAt), shift: shiftEnd ? { startsAt: at(inAt), endsAt: at(shiftEnd), breakMinutes: 0 } : null });
    expect(isAbandoned(open("2026-11-20T10:00:00Z", null), NOW)).toBe(false); // 20h exactly
    expect(isAbandoned(open("2026-11-20T09:59:00Z", null), NOW)).toBe(true);
    expect(isAbandoned(open("2026-11-21T00:00:00Z", "2026-11-21T01:59:00Z"), NOW)).toBe(true); // 4h01 after the shift
    expect(isAbandoned(open("2026-11-21T00:00:00Z", "2026-11-21T02:00:00Z"), NOW)).toBe(false);
    expect(isAbandoned({ ...open("2026-11-01T00:00:00Z", null), status: "CLOSED" }, NOW)).toBe(false);
  });
  it("calls a shift missed only when it is over and nothing (but void records) is linked to it", () => {
    const shift = { status: "PLANNED" as const, endsAt: at("2026-11-21T05:00:00Z") };
    expect(isMissedShift(shift, [], NOW)).toBe(true);
    expect(isMissedShift(shift, [{ status: "VOID" }], NOW)).toBe(true);
    expect(isMissedShift(shift, [{ status: "MISSING_OUT" }], NOW)).toBe(false);
    expect(isMissedShift({ ...shift, endsAt: at("2026-11-21T07:00:00Z") }, [], NOW)).toBe(false);
    expect(isMissedShift({ ...shift, status: "CANCELLED" }, [], NOW)).toBe(false);
  });
});

describe("local days", () => {
  it("buckets by the organisation's day and gives real day lengths across clock changes", () => {
    expect(localDay(at("2026-11-20T19:00:00Z"), IST)).toBe("2026-11-21"); // 00:30 in India
    const india = dayRange("2026-11-21", IST);
    expect(india.start.toISOString()).toBe("2026-11-20T18:30:00.000Z");
    expect(india.end.getTime() - india.start.getTime()).toBe(24 * 3600_000);
    const springForward = dayRange("2026-03-29", "Europe/London");
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3600_000);
    const fallBack = dayRange("2026-10-25", "Europe/London");
    expect(fallBack.end.getTime() - fallBack.start.getTime()).toBe(25 * 3600_000);
  });
  it("finds the Monday of a week and checks dates", () => {
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // Sunday
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2026-11-21")).toBe("2026-11-16");
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
  });
});

describe("parsing periods and shifts", () => {
  it("reads night work: an end at or before the start is the next day", () => {
    const p = parsePeriod({ day: "2026-11-20", start: "22:00", end: "06:00" }, IST, { maxHours: 16 });
    expect(p.ok && [p.value.start.toISOString(), p.value.end!.toISOString()]).toEqual(["2026-11-20T16:30:00.000Z", "2026-11-21T00:30:00.000Z"]);
  });
  it("refuses times that do not exist on a clock change, and periods that are too long", () => {
    expect(parsePeriod({ day: "2026-03-29", start: "01:30", end: "05:00" }, "Europe/London", { maxHours: 16 })).toMatchObject({ ok: false, errors: { start: expect.any(String) } });
    expect(parsePeriod({ day: "2026-11-20", start: "06:00", end: "23:00" }, IST, { maxHours: 16 })).toMatchObject({ ok: false, errors: { end: expect.stringMatching(/16 hours/) } });
    expect(parsePeriod({ day: "2026-11-20", start: "9:00", end: "" }, IST, { maxHours: 16 })).toMatchObject({ ok: false, errors: { start: expect.any(String), end: expect.any(String) } });
    expect(parsePeriod({ day: "2026-11-20", start: "09:00", end: "" }, IST, { maxHours: 16, endOptional: true })).toMatchObject({ ok: true, value: { end: null } });
  });
  it("plans shifts only for the future, with a break shorter than the shift", () => {
    const base = { employeeId: "11111111-1111-4111-8111-111111111111", outletId: "22222222-2222-4222-8222-222222222222", day: "2026-11-22", start: "09:00", end: "17:00", breakMinutes: "30" };
    const ok = parseShiftInput(base, IST, NOW);
    expect(ok).toMatchObject({ ok: true, value: { breakMinutes: 30, note: null } });
    expect(parseShiftInput({ ...base, day: "2026-11-20" }, IST, NOW)).toMatchObject({ ok: false, errors: { end: expect.stringMatching(/already over/) } });
    expect(parseShiftInput({ ...base, breakMinutes: "480" }, IST, NOW)).toMatchObject({ ok: false, errors: { breakMinutes: expect.any(String) } });
    expect(parseShiftInput({ ...base, employeeId: "x" }, IST, NOW)).toMatchObject({ ok: false, errors: { employeeId: expect.any(String) } });
  });
  it("accepts worked periods only in the past, within the allowed days, with a reason when required", () => {
    const req = (over: Record<string, string>) => parsePeriodInput({ day: "2026-11-20", start: "09:00", end: "17:00", reason: "Phone died", ...over }, IST, NOW, { reasonRequired: true, maxDaysBack: 31 });
    expect(req({})).toMatchObject({ ok: true, value: { breakMinutes: null, reason: "Phone died" } });
    expect(req({ reason: " " })).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(req({ day: "2026-11-21", start: "10:00", end: "18:00" })).toMatchObject({ ok: false, errors: { end: expect.any(String) } });
    expect(req({ day: "2026-10-01" })).toMatchObject({ ok: false, errors: { day: expect.stringMatching(/31 days/) } });
    expect(req({ breakMinutes: "480" })).toMatchObject({ ok: false, errors: { breakMinutes: expect.any(String) } });
    expect(parseRequiredReason("  ")).toMatchObject({ ok: false });
    expect(parseRequiredReason("x".repeat(501))).toMatchObject({ ok: false });
  });
});

describe("copying shifts a week later", () => {
  it("keeps the local wall-clock time across a clock change", () => {
    const london = "Europe/London";
    // Monday 19 Oct 2026, 09:00-17:00 London summer time -> Monday 26 Oct, after the clocks went back: still 09:00-17:00.
    const moved = shiftByDays(at("2026-10-19T08:00:00Z"), at("2026-10-19T16:00:00Z"), 7, london);
    expect(moved && [moved.start.toISOString(), moved.end.toISOString()]).toEqual(["2026-10-26T09:00:00.000Z", "2026-10-26T17:00:00.000Z"]);
    expect(localDay(moved!.start, london)).toBe("2026-10-26");
    // A night shift keeps its shape too, and India (no clock change) moves by exactly 7 days.
    const night = shiftByDays(at("2026-11-20T16:30:00Z"), at("2026-11-21T00:30:00Z"), 7, IST)!;
    expect(night.end.getTime() - night.start.getTime()).toBe(8 * 3600_000);
    expect(night.start.getTime() - at("2026-11-20T16:30:00Z").getTime()).toBe(7 * 86_400_000);
  });
  it("gives up on a local time that does not exist on the new day", () => {
    // 01:30 on 29 Mar 2026 does not exist in London (clocks jump from 01:00 to 02:00).
    expect(shiftByDays(at("2026-03-22T01:30:00Z"), at("2026-03-22T05:00:00Z"), 7, "Europe/London")).toBeNull();
  });
});

describe("database refusals", () => {
  it("reads only the database's own message out of a Prisma error", () => {
    const prismaError = { message: 'Invalid `prisma.shift.create()` invocation:\n{ data: { note: "already_clocked_in" } }\nRaw query failed. Code: `P0001`. Message: `shift_over`', meta: {} };
    expect(databaseMessage(prismaError)).toBe("shift_over");
    expect(dbRefusal(databaseMessage(prismaError)!)).toBe("shift_over");
    expect(databaseMessage({ message: "x", meta: { driverAdapterError: { cause: { originalMessage: "attendance_overlap" } } } })).toBe("attendance_overlap");
    expect(databaseMessage({ message: "Something unrelated mentioning already_clocked_in" })).toBeNull();
  });
  it("finds the refusal code in a database error and ignores unknown errors", () => {
    expect(dbRefusal('ERROR: already_clocked_in\nCONTEXT: PL/pgSQL function app_clock_in')).toBe("already_clocked_in");
    expect(dbRefusal('conflicting key value violates exclusion constraint "shifts_no_overlap"')).toBe("shifts_no_overlap");
    expect(dbRefusal("connection terminated")).toBeNull();
  });
});
