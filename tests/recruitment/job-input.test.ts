import { describe, expect, it } from "vitest";
import {
  dateInTimeZone,
  endOfDayInTimeZone,
  formDataToJobFields,
  parseJobInput,
  parseSkills,
  pickFreeSlug,
  slugify,
} from "@/lib/recruitment/job-input";

const valid = {
  title: "Senior Barista",
  description: "Make excellent coffee and train new baristas on the bar.",
  employmentType: "FULL_TIME",
  workMode: "ON_SITE",
  visibility: "PUBLIC",
};

describe("parseJobInput", () => {
  it("accepts a minimal job and fills defaults", () => {
    const r = parseJobInput(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      title: "Senior Barista",
      departmentId: null,
      location: null,
      requiredSkills: [],
      compensationMin: null,
      openingsCount: 1,
      applicationDeadline: null,
    });
  });

  it("trims text and turns empty boxes into null", () => {
    const r = parseJobInput({ ...valid, title: "  Barista  ", location: "   ", qualifications: "" });
    expect(r.ok && r.value).toMatchObject({ title: "Barista", location: null, qualifications: null });
  });

  it("reports one message per field", () => {
    const r = parseJobInput({ title: "ab", description: "short" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["description", "employmentType", "title", "visibility", "workMode"]);
  });

  it("rejects unknown enum values", () => {
    const r = parseJobInput({ ...valid, employmentType: "SLAVE_LABOUR" });
    expect(r.ok).toBe(false);
  });

  it("keeps pay as exact text and rejects bad numbers", () => {
    const ok = parseJobInput({ ...valid, compensationMin: "18,000", compensationMax: "22000.50", compensationPeriod: "per month" });
    expect(ok.ok && ok.value).toMatchObject({ compensationMin: "18000", compensationMax: "22000.50" });
    expect(parseJobInput({ ...valid, compensationMin: "-5", compensationPeriod: "per month" }).ok).toBe(false);
    expect(parseJobInput({ ...valid, compensationMin: "1e5", compensationPeriod: "per month" }).ok).toBe(false);
    expect(parseJobInput({ ...valid, compensationMin: "1.234", compensationPeriod: "per month" }).ok).toBe(false);
  });

  it("requires max >= min and a pay period when pay is given", () => {
    const r = parseJobInput({ ...valid, compensationMin: "30000", compensationMax: "20000" });
    expect(!r.ok && r.errors).toMatchObject({ compensationMax: expect.any(String), compensationPeriod: expect.any(String) });
  });

  it("allows internship length only for internships", () => {
    expect(parseJobInput({ ...valid, internshipMonths: "3" }).ok).toBe(false);
    const r = parseJobInput({ ...valid, employmentType: "INTERNSHIP", internshipMonths: "3" });
    expect(r.ok && r.value.internshipMonths).toBe("3");
    expect(parseJobInput({ ...valid, employmentType: "INTERNSHIP", internshipMonths: "2.5" }).ok).toBe(false);
    expect(parseJobInput({ ...valid, employmentType: "INTERNSHIP", internshipMonths: "0" }).ok).toBe(false);
  });

  it("checks openings and the deadline date", () => {
    expect(parseJobInput({ ...valid, openingsCount: "0" }).ok).toBe(false);
    expect(parseJobInput({ ...valid, openingsCount: "two" }).ok).toBe(false);
    expect(parseJobInput({ ...valid, applicationDeadline: "31/12/2026" }).ok).toBe(false);
    const r = parseJobInput({ ...valid, openingsCount: "3", applicationDeadline: "2026-12-31" });
    expect(r.ok && r.value).toMatchObject({ openingsCount: 3, applicationDeadline: "2026-12-31" });
  });

  it("rejects a department id that is not a UUID", () => {
    expect(parseJobInput({ ...valid, departmentId: "1; drop table" }).ok).toBe(false);
  });
});

describe("formDataToJobFields", () => {
  it("reads known fields only and drops duplicates and files", () => {
    const fd = new FormData();
    fd.set("title", "Barista");
    fd.set("organizationId", "someone-elses-org");
    fd.append("location", "A");
    fd.append("location", "B");
    fd.set("description", new Blob(["x"]));
    const fields = formDataToJobFields(fd);
    expect(fields.title).toBe("Barista");
    expect(fields).not.toHaveProperty("organizationId");
    expect(fields.location).toBeUndefined();
    expect(fields.description).toBeUndefined();
  });
});

describe("skills, slugs", () => {
  it("splits skills on commas and new lines, without duplicates", () => {
    expect(parseSkills("Latte art, Espresso,\n latte  ART ,, ")).toEqual(["Latte art", "Espresso"]);
  });

  it("makes database-safe slugs", () => {
    expect(slugify("Senior Barista (Night Shift)")).toBe("senior-barista-night-shift");
    expect(slugify("Café Manager")).toBe("cafe-manager");
    expect(slugify("बरिस्ता")).toBe("job");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(74);
    for (const s of [slugify("--a--b--"), slugify("A & B / C")]) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("picks the first free slug", () => {
    expect(pickFreeSlug("barista", new Set())).toBe("barista");
    expect(pickFreeSlug("barista", new Set(["barista", "barista-2"]))).toBe("barista-3");
  });
});

describe("time zones", () => {
  it("closes at the end of the day in the organisation's zone", () => {
    expect(endOfDayInTimeZone("2026-12-31", "Asia/Kolkata").toISOString()).toBe("2026-12-31T18:29:59.999Z");
    expect(endOfDayInTimeZone("2026-12-31", "UTC").toISOString()).toBe("2026-12-31T23:59:59.999Z");
    // New York in summer is UTC-4
    expect(endOfDayInTimeZone("2026-07-01", "America/New_York").toISOString()).toBe("2026-07-02T03:59:59.999Z");
  });

  it("shows the stored deadline as the same calendar date", () => {
    const d = endOfDayInTimeZone("2026-03-01", "Asia/Kolkata");
    expect(dateInTimeZone(d, "Asia/Kolkata")).toBe("2026-03-01");
  });
});
