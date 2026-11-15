import { describe, expect, it } from "vitest";
import { availableJobActions, canTransition, isJobAction } from "@/lib/recruitment/job-status";

describe("job status rules", () => {
  it("follows the agreed life cycle", () => {
    expect(canTransition("DRAFT", "publish")).toBe(true);
    expect(canTransition("PUBLISHED", "close")).toBe(true);
    expect(canTransition("CLOSED", "reopen")).toBe(true);
    expect(canTransition("CLOSED", "archive")).toBe(true);
    expect(canTransition("DRAFT", "close")).toBe(false);
    expect(canTransition("PUBLISHED", "archive")).toBe(false); // close first
  });

  it("never leaves ARCHIVED", () => {
    for (const a of ["publish", "unpublish", "close", "reopen", "archive"] as const) {
      expect(canTransition("ARCHIVED", a)).toBe(false);
    }
  });

  it("offers only what the person is allowed to do", () => {
    expect(availableJobActions("PUBLISHED", new Set(["job:publish"]))).toEqual(["unpublish"]);
    expect(availableJobActions("PUBLISHED", new Set(["job:publish", "job:close"]))).toEqual(["unpublish", "close"]);
    expect(availableJobActions("DRAFT", new Set())).toEqual([]);
  });

  it("recognises actions sent by the browser", () => {
    expect(isJobAction("close")).toBe(true);
    expect(isJobAction("delete")).toBe(false);
    expect(isJobAction(undefined)).toBe(false);
  });
});
