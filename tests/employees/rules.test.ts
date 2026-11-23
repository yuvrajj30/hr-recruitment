import { describe, expect, it } from "vitest";
import {
  addDays,
  formDataToEmployeeFields,
  isCalendarDate,
  parseEmployeeInput,
  parseExitDate,
  parseStructureInput,
} from "@/lib/employees/rules";

const TODAY = "2026-11-21";
const ID = "123e4567-e89b-42d3-a456-426614174000";
const valid = { employeeCode: "TTC-014", fullName: "  Asha   Rao ", joinedOn: "2026-11-01" };

describe("isCalendarDate", () => {
  it("accepts real dates only", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("26-02-28")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("addDays", () => {
  it("moves across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("parseEmployeeInput", () => {
  it("accepts the minimum, tidies text and defaults the type", () => {
    const r = parseEmployeeInput(valid, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fullName).toBe("Asha Rao");
      expect(r.value.employmentType).toBe("FULL_TIME");
      expect(r.value.email).toBeNull();
      expect(r.value.managerId).toBeNull();
    }
  });

  it("lower-cases the email and keeps valid references", () => {
    const r = parseEmployeeInput({ ...valid, email: "Asha@Example.COM", phone: "+91 98765 43210", managerId: ID, outletId: ID }, TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe("asha@example.com");
      expect(r.value.managerId).toBe(ID);
    }
  });

  it("reports each bad field", () => {
    const r = parseEmployeeInput({ employeeCode: "bad code!", fullName: "", email: "nope", phone: "12", employmentType: "X", joinedOn: "2026-02-30", outletId: "abc" }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(["email", "employeeCode", "employmentType", "fullName", "joinedOn", "outletId", "phone"]);
    }
  });

  it("refuses a joining date more than a year ahead but allows near-future dates", () => {
    expect(parseEmployeeInput({ ...valid, joinedOn: "2026-12-15" }, TODAY).ok).toBe(true);
    expect(parseEmployeeInput({ ...valid, joinedOn: "2028-01-01" }, TODAY).ok).toBe(false);
  });

  it("treats missing fields as empty", () => {
    expect(parseEmployeeInput({}, TODAY).ok).toBe(false);
  });
});

describe("parseExitDate", () => {
  it("accepts a date on or after joining", () => {
    expect(parseExitDate("2026-11-01", "2026-11-01", TODAY)).toEqual({ ok: true, value: "2026-11-01" });
  });
  it("refuses before joining, invalid and too far ahead", () => {
    expect(parseExitDate("2026-10-31", "2026-11-01", TODAY).ok).toBe(false);
    expect(parseExitDate("soon", "2026-11-01", TODAY).ok).toBe(false);
    expect(parseExitDate("2028-01-01", "2026-11-01", TODAY).ok).toBe(false);
  });
});

describe("parseStructureInput", () => {
  it("requires a name and tidies it", () => {
    expect(parseStructureInput({ name: "  Main   Cafe " }, true)).toEqual({ ok: true, value: { name: "Main Cafe", address: null } });
    expect(parseStructureInput({ name: "" }, false).ok).toBe(false);
  });
  it("keeps the address only for outlets", () => {
    const outlet = parseStructureInput({ name: "A", address: "1 High St" }, true);
    const dept = parseStructureInput({ name: "A", address: "1 High St" }, false);
    expect(outlet.ok && outlet.value.address).toBe("1 High St");
    expect(dept.ok && dept.value.address).toBeNull();
  });
  it("limits the address length", () => {
    expect(parseStructureInput({ name: "A", address: "x".repeat(501) }, true).ok).toBe(false);
  });
});

describe("formDataToEmployeeFields", () => {
  it("reads only the expected text fields", () => {
    const fd = new FormData();
    fd.set("employeeCode", "T-1");
    fd.set("isAdmin", "yes");
    const f = formDataToEmployeeFields(fd);
    expect(f.employeeCode).toBe("T-1");
    expect(f.fullName).toBeUndefined();
    expect("isAdmin" in f).toBe(false);
  });
});
