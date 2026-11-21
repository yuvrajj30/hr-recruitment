// Leave rules (src/lib/leave/rules.ts): pure input parsing and display helpers. The database re-checks everything.
import { describe, expect, it } from "vitest";
import {
  formatDays, LEAVE_DB_MESSAGES, LEAVE_LIMITS, leaveRefusal, parseAdjustment, parseHoliday, parseLeaveRequest, parseLeaveType, splitAtYearEnd,
} from "@/lib/leave/rules";

const TYPE = "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const TODAY = "2026-11-22";

describe("parseLeaveRequest", () => {
  it("accepts a range with halves and an optional note", () => {
    expect(parseLeaveRequest({ typeId: TYPE, start: "2026-12-01", end: "2026-12-03", startHalf: "on", endHalf: false, note: "  Family visit " }, TODAY))
      .toEqual({ ok: true, value: { typeId: TYPE, start: "2026-12-01", end: "2026-12-03", startHalf: true, endHalf: false, note: "Family visit" } });
    expect(parseLeaveRequest({ typeId: TYPE, start: "2026-12-01", end: "2026-12-01" }, TODAY))
      .toEqual({ ok: true, value: { typeId: TYPE, start: "2026-12-01", end: "2026-12-01", startHalf: false, endHalf: false, note: null } });
  });

  it("refuses a missing type, bad dates and an end before the start", () => {
    const r = parseLeaveRequest({ typeId: "nope", start: "2026-12-05", end: "2026-12-04" }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.typeId).toBeTruthy();
      expect(r.errors.end).toMatch(/on or after the first day/);
    }
    const bad = parseLeaveRequest({ typeId: TYPE, start: "2026-02-30", end: "" }, TODAY);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["end", "start"]);
  });

  it(`allows ${LEAVE_LIMITS.daysBack} days back and ${LEAVE_LIMITS.daysAhead} days ahead, no further`, () => {
    expect(parseLeaveRequest({ typeId: TYPE, start: "2026-10-22", end: "2026-10-22" }, TODAY).ok).toBe(true); // 31 days back
    const back = parseLeaveRequest({ typeId: TYPE, start: "2026-10-21", end: "2026-10-21" }, TODAY);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.errors.start).toMatch(/31 days/);
    expect(parseLeaveRequest({ typeId: TYPE, start: "2027-11-22", end: "2027-11-22" }, TODAY).ok).toBe(true); // 365 ahead
    const ahead = parseLeaveRequest({ typeId: TYPE, start: "2027-11-22", end: "2027-11-23" }, TODAY);
    expect(ahead.ok).toBe(false);
    if (!ahead.ok) expect(ahead.errors.end).toMatch(/365 days/);
  });

  it("keeps notes to 500 characters", () => {
    const r = parseLeaveRequest({ typeId: TYPE, start: "2026-12-01", end: "2026-12-01", note: "x".repeat(501) }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.note).toMatch(/500/);
  });
});

describe("splitAtYearEnd", () => {
  it("splits a request that crosses 31 December into one part per year", () => {
    expect(splitAtYearEnd("2026-12-30", "2027-01-02")).toEqual([["2026-12-30", "2026-12-31"], ["2027-01-01", "2027-01-02"]]);
    expect(splitAtYearEnd("2026-12-01", "2026-12-31")).toEqual([["2026-12-01", "2026-12-31"]]);
    expect(splitAtYearEnd("2026-12-31", "2028-01-01")).toEqual([["2026-12-31", "2026-12-31"], ["2027-01-01", "2027-12-31"], ["2028-01-01", "2028-01-01"]]);
  });
});

describe("formatDays", () => {
  it("writes halves as ½ and uses the singular for one day or less", () => {
    expect(formatDays(1.5)).toBe("1½ days");
    expect(formatDays(0.5)).toBe("½ day");
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(0)).toBe("0 days");
    expect(formatDays(12)).toBe("12 days");
    expect(formatDays(-2.5)).toBe("−2½ days");
  });
});

describe("parseLeaveType", () => {
  it("accepts settings in half-day steps and uppercases a new code", () => {
    expect(parseLeaveType({ code: "ml", name: " Marriage leave ", paid: "on", accrual: "NONE", daysPerYear: "3", carryOverMax: "0", noteRequired: "on", isActive: "on" }))
      .toEqual({ ok: true, value: { code: "ML", name: "Marriage leave", paid: true, accrual: "NONE", daysPerYear: 3, carryOverMax: 0, noteRequired: true, isActive: true } });
    const r = parseLeaveType({ code: "1X", name: "", paid: "on", accrual: "WEEKLY", daysPerYear: "2.3", carryOverMax: "-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["accrual", "carryOverMax", "code", "daysPerYear", "name"]);
  });

  it("refuses a balance on unpaid leave", () => {
    const r = parseLeaveType({ code: "UL", name: "Unpaid", accrual: "YEARLY", daysPerYear: "5", carryOverMax: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.daysPerYear).toMatch(/Unpaid/);
  });
});

describe("parseHoliday and parseAdjustment", () => {
  it("reads a holiday for all outlets or one", () => {
    expect(parseHoliday({ day: "2026-12-25", name: " Christmas ", outletId: "" })).toEqual({ ok: true, value: { day: "2026-12-25", name: "Christmas", outletId: null } });
    expect(parseHoliday({ day: "2026-12-25", name: "Christmas", outletId: TYPE })).toEqual({ ok: true, value: { day: "2026-12-25", name: "Christmas", outletId: TYPE } });
    expect(parseHoliday({ day: "x", name: "" }).ok).toBe(false);
  });

  it("needs non-zero half-day steps and a reason for an adjustment", () => {
    expect(parseAdjustment({ typeId: TYPE, year: "2026", days: "-1.5", reason: "Correction" })).toEqual({ ok: true, value: { typeId: TYPE, year: 2026, days: -1.5, reason: "Correction" } });
    const r = parseAdjustment({ typeId: TYPE, year: "1999", days: "0", reason: " " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["days", "reason", "year"]);
    expect(parseAdjustment({ typeId: TYPE, year: "2026", days: "0.3", reason: "x" }).ok).toBe(false);
  });
});

describe("leave refusals", () => {
  it("has a message for every refusal code the leave functions raise", () => {
    for (const code of [
      "leave_type_inactive", "leave_type_not_configured", "leave_bad_period", "leave_crosses_year", "leave_too_far_back", "leave_too_far_ahead",
      "employee_not_active", "leave_note_required", "leave_zero_days", "leave_insufficient_balance", "leave_overlap", "request_not_pending",
      "own_request", "decision_note_required", "reason_required", "leave_already_started", "leave_type_unpaid", "adjust_bad_days",
      "adjust_negative_balance", "no_employee_record", "on_leave", "not_found", "leave_type_fixed_fields",
    ]) expect(LEAVE_DB_MESSAGES[code], code).toBeTruthy();
  });

  it("reads the code from PostgreSQL's message only, longest first", () => {
    expect(leaveRefusal("leave_type_not_configured")).toBe("leave_type_not_configured");
    expect(leaveRefusal('duplicate key value violates unique constraint "holidays_organization_id_outlet_day_key"')).toBe("holidays_organization_id_outlet_day_key");
    expect(leaveRefusal("something else")).toBeNull();
  });
});
