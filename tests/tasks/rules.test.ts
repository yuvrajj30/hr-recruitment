// Task rules (src/lib/tasks/rules.ts): pure input parsing, labels, overdue and refusal messages. The database checks
// everything again (migrations 20261124000000_tasks, 20261124000100_task_functions, 20261124000200_task_fixes).
import { describe, expect, it } from "vitest";
import {
  isOverdue, parseLink, parseReview, parseTaskInput, RATING_LABELS, TASK_DB_MESSAGES, TASK_LIMITS, taskRefusal,
} from "@/lib/tasks/rules";

const OWNER = "6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const OUTLET = "7a1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const TODAY = "2026-11-24";
const base = { ownerId: OWNER, outletId: OUTLET, title: "Descale the machine", description: "Descale it and send a photo.", dueOn: TODAY, dueTime: "", priority: "HIGH", proof: ["PHOTO", "TEXT"] };

describe("parseTaskInput", () => {
  it("accepts a task due today with a time, trimming text and keeping proof kinds once", () => {
    expect(parseTaskInput({ ...base, title: "  Descale the machine ", dueTime: "18:30", proof: ["PHOTO", "TEXT", "PHOTO"] }, TODAY)).toEqual({
      ok: true,
      value: { ownerId: OWNER, outletId: OUTLET, title: "Descale the machine", description: "Descale it and send a photo.", dueOn: TODAY, dueTime: "18:30", priority: "HIGH", proof: ["PHOTO", "TEXT"] },
    });
    expect(parseTaskInput({ ...base, priority: "", proof: "DOCUMENT" }, TODAY)).toMatchObject({ ok: true, value: { priority: "NORMAL", proof: ["DOCUMENT"], dueTime: null } });
  });

  it("refuses a missing owner or outlet, a 121-character title, no proof and a due date in the past", () => {
    const r = parseTaskInput({ ...base, ownerId: "", outletId: "x", title: "x".repeat(TASK_LIMITS.titleMax + 1), proof: [], dueOn: "2026-11-23" }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["dueOn", "outletId", "ownerId", "proof", "title"]);
    const bad = parseTaskInput({ ...base, description: "", priority: "SOON", dueTime: "25:00", proof: ["VIDEO"] }, TODAY);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["description", "dueTime", "priority", "proof"]);
  });
});

describe("parseTaskInput when editing", () => {
  it("keeps an unchanged past deadline (an overdue task can still be edited or moved) but refuses a new past date", () => {
    expect(parseTaskInput({ ...base, dueOn: "2026-11-20" }, TODAY, { currentDueOn: "2026-11-20" }).ok).toBe(true);
    const moved = parseTaskInput({ ...base, dueOn: "2026-11-21" }, TODAY, { currentDueOn: "2026-11-20" });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.errors.dueOn).toMatch(/past/);
  });
});

describe("parseReview and parseLink", () => {
  it("needs a rating 1-5 to approve and a note (no rating) to request changes", () => {
    expect(parseReview({ decision: "approve", rating: "4", note: " Clean " })).toEqual({ ok: true, value: { approve: true, rating: 4, note: "Clean" } });
    expect(parseReview({ decision: "approve", rating: "", note: "" }).ok).toBe(false);
    expect(parseReview({ decision: "approve", rating: "6" }).ok).toBe(false);
    expect(parseReview({ decision: "changes", note: "Photo too dark" })).toEqual({ ok: true, value: { approve: false, rating: null, note: "Photo too dark" } });
    expect(parseReview({ decision: "changes", note: "" }).ok).toBe(false);
    expect(parseReview({ decision: "maybe" }).ok).toBe(false);
    expect(RATING_LABELS).toEqual({ 1: "Poor", 2: "Below expectations", 3: "Meets expectations", 4: "Good", 5: "Excellent" });
  });

  it("accepts only https links up to 500 characters", () => {
    expect(parseLink(" https://example.com/guide ")).toEqual({ ok: true, value: "https://example.com/guide" });
    for (const bad of ["http://example.com", "javascript:alert(1)", "https://", "https://a b.com", `https://x.com/${"a".repeat(500)}`, ""]) {
      expect(parseLink(bad).ok, bad).toBe(false);
    }
  });
});

describe("isOverdue", () => {
  const tz = "Asia/Kolkata";
  it("is overdue after the end of the due day, or after the due time when there is one; never once done", () => {
    const open = { status: "IN_PROGRESS" as const, dueOn: "2026-11-24", dueTime: null };
    expect(isOverdue(open, new Date("2026-11-24T18:29:00Z"), tz)).toBe(false); // 23:59 in Indore
    expect(isOverdue(open, new Date("2026-11-24T18:31:00Z"), tz)).toBe(true); // 00:01 next day
    const timed = { ...open, dueTime: "15:00" };
    expect(isOverdue(timed, new Date("2026-11-24T09:29:00Z"), tz)).toBe(false); // 14:59
    expect(isOverdue(timed, new Date("2026-11-24T09:31:00Z"), tz)).toBe(true); // 15:01
    for (const status of ["SUBMITTED", "APPROVED", "CANCELLED"] as const) expect(isOverdue({ ...open, status }, new Date("2026-12-31T00:00:00Z"), tz)).toBe(false);
  });
});

describe("task refusals", () => {
  it("has a message for every code the task functions raise, read from PostgreSQL's message only", () => {
    for (const code of [
      "not_found", "task_not_open", "task_bad_transition", "task_not_owner", "employee_not_active", "employee_no_login", "outlet_not_active",
      "task_due_in_past", "task_proof_missing", "task_too_many_files", "task_bad_file", "own_task", "note_required", "reason_required",
      "text_too_long", "text_required", "rating_required", "rating_not_allowed", "bad_link", "too_many_resources",
    ]) expect(TASK_DB_MESSAGES[code], code).toBeTruthy();
    expect(taskRefusal("employee_no_login")).toBe("employee_no_login");
    expect(taskRefusal("task_not_open")).toBe("task_not_open");
    expect(taskRefusal("something else")).toBeNull();
  });
});
