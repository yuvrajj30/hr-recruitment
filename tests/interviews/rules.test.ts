import { describe, expect, it } from "vitest";
import {
  canRecordOutcome,
  canScheduleFor,
  dateToZonedInput,
  feedbackOpen,
  parseCancelReason,
  parseDecisionInput,
  parseFeedbackInput,
  parseScheduleInput,
  stageAfterInterviewEnded,
  canEditInterview,
  onHoldRefusal,
  INTERVIEW_LIMITS,
  stageAfterScheduling,
  stageForDecision,
  zonedInputToDate,
} from "@/lib/interviews/rules";

const KOLKATA = "Asia/Kolkata";
const now = new Date("2026-11-18T06:00:00Z"); // 11:30 in Kolkata
const ids = ["0196f0c4-0000-7000-8000-000000000001", "0196f0c4-0000-7000-8000-000000000002"];
const base = { type: "IN_PERSON", start: "2026-11-20T15:30", duration: "45", location: "Koramangala outlet", participantIds: [ids[0]!] };

describe("interview times in the organisation's time zone", () => {
  it("reads the local time typed into the form as the exact moment", () => {
    expect(zonedInputToDate("2026-11-20T15:30", KOLKATA)?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(zonedInputToDate("2026-11-20T15:30", "UTC")?.toISOString()).toBe("2026-11-20T15:30:00.000Z");
  });
  it("shows the moment back as the same local time", () => {
    expect(dateToZonedInput(new Date("2026-11-20T10:00:00Z"), KOLKATA)).toBe("2026-11-20T15:30");
  });
  it("handles a daylight-saving change correctly", () => {
    // London, 29 Mar 2026: clocks go from 01:00 GMT to 02:00 BST. 09:00 local is 08:00 UTC.
    expect(zonedInputToDate("2026-03-29T09:00", "Europe/London")?.toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(zonedInputToDate("2026-03-28T09:00", "Europe/London")?.toISOString()).toBe("2026-03-28T09:00:00.000Z");
  });
  it("refuses a time skipped by a spring-forward clock change", () => {
    expect(zonedInputToDate("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(zonedInputToDate("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
    expect(zonedInputToDate("2026-03-29T03:30", "Europe/Berlin")?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("refuses things that are not real times", () => {
    for (const bad of ["", "2026-11-20", "2026-02-30T10:00", "2026-13-01T10:00", "2026-11-20T24:00", "tomorrow"]) expect(zonedInputToDate(bad, KOLKATA)).toBeNull();
  });
});

describe("scheduling input", () => {
  it("accepts a complete in-person interview and works out the end time", () => {
    const r = parseScheduleInput(base, { timeZone: KOLKATA, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.start.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(r.value.end.toISOString()).toBe("2026-11-20T10:45:00.000Z");
    expect(r.value.location).toBe("Koramangala outlet");
    expect(r.value.meetingLink).toBeNull();
  });
  it("needs a place for in-person and an https link for online interviews", () => {
    expect(parseScheduleInput({ ...base, location: "" }, { timeZone: KOLKATA, now })).toMatchObject({ ok: false, errors: { location: expect.any(String) } });
    const online = { ...base, type: "ONLINE", location: "" };
    expect(parseScheduleInput(online, { timeZone: KOLKATA, now })).toMatchObject({ ok: false, errors: { meetingLink: expect.any(String) } });
    expect(parseScheduleInput({ ...online, meetingLink: "http://meet.example.com/x" }, { timeZone: KOLKATA, now }).ok).toBe(false);
    expect(parseScheduleInput({ ...online, meetingLink: "https://meet example.com" }, { timeZone: KOLKATA, now }).ok).toBe(false);
    const ok = parseScheduleInput({ ...online, meetingLink: "https://meet.example.com/abc-defg" }, { timeZone: KOLKATA, now });
    expect(ok.ok && ok.value.meetingLink).toBe("https://meet.example.com/abc-defg");
  });
  it("keeps only the details that belong to the chosen kind of interview", () => {
    const r = parseScheduleInput({ ...base, type: "PHONE", meetingLink: "https://meet.example.com/x" }, { timeZone: KOLKATA, now });
    expect(r.ok && [r.value.location, r.value.meetingLink]).toEqual([null, null]);
  });
  it("requires a time in the future, within a year", () => {
    expect(parseScheduleInput({ ...base, start: "2026-11-18T11:30" }, { timeZone: KOLKATA, now })).toMatchObject({ ok: false, errors: { start: "Choose a time in the future." } });
    expect(parseScheduleInput({ ...base, start: "2027-12-01T10:00" }, { timeZone: KOLKATA, now }).ok).toBe(false);
    // When editing, an unchanged past start is let through here (the service checks it only if it changed).
    expect(parseScheduleInput({ ...base, start: "2026-11-18T09:00" }, { timeZone: KOLKATA, now, requireFuture: false }).ok).toBe(true);
  });
  it("allows only the offered lengths", () => {
    for (const d of ["10", "500", "abc", ""]) expect(parseScheduleInput({ ...base, duration: d }, { timeZone: KOLKATA, now }).ok).toBe(false);
  });
  it("needs one to ten interviewers, given as ids, without duplicates", () => {
    expect(parseScheduleInput({ ...base, participantIds: [] }, { timeZone: KOLKATA, now })).toMatchObject({ ok: false, errors: { participantIds: expect.any(String) } });
    expect(parseScheduleInput({ ...base, participantIds: ["robert'); DROP TABLE"] }, { timeZone: KOLKATA, now }).ok).toBe(false);
    const r = parseScheduleInput({ ...base, participantIds: [ids[0]!, ids[0]!, ids[1]!] }, { timeZone: KOLKATA, now });
    expect(r.ok && r.value.participantIds).toEqual(ids);
    const many = Array.from({ length: 11 }, (_, i) => `0196f0c4-0000-7000-8000-${String(i).padStart(12, "0")}`);
    expect(parseScheduleInput({ ...base, participantIds: many }, { timeZone: KOLKATA, now }).ok).toBe(false);
  });
  it("refuses an unknown kind of interview", () => {
    expect(parseScheduleInput({ ...base, type: "VIDEO" }, { timeZone: KOLKATA, now })).toMatchObject({ ok: false, errors: { type: expect.any(String) } });
  });
});

describe("feedback input", () => {
  it("lets a draft be incomplete", () => {
    const r = parseFeedbackInput({ communication: "4", strengths: "  Friendly with customers  " }, "draft");
    expect(r.ok && r.value).toMatchObject({ ratings: { communication: 4, overallRating: null }, strengths: "Friendly with customers", recommendation: null });
  });
  it("needs an overall score and a recommendation to submit", () => {
    const r = parseFeedbackInput({ communication: "4" }, "submit");
    expect(r).toMatchObject({ ok: false, errors: { overallRating: expect.any(String), recommendation: expect.any(String) } });
    expect(parseFeedbackInput({ overallRating: "5", recommendation: "RECOMMEND" }, "submit").ok).toBe(true);
  });
  it("accepts scores 1 to 5 only, and known recommendations only", () => {
    for (const bad of ["0", "6", "3.5", "x"]) expect(parseFeedbackInput({ communication: bad }, "draft").ok).toBe(false);
    expect(parseFeedbackInput({ recommendation: "HIRE_NOW" }, "draft").ok).toBe(false);
  });
  it("limits how much can be written", () => {
    expect(parseFeedbackInput({ notes: "x".repeat(4001) }, "draft").ok).toBe(false);
  });
});

describe("decisions and cancellations", () => {
  it("keeps a decision reason within what the stage history can hold", () => {
    expect(INTERVIEW_LIMITS.rationale).toBe(1000);
    expect(parseDecisionInput({ outcome: "REJECTED", rationale: "x".repeat(1001) }).ok).toBe(false);
  });
  it("needs a known outcome and a short reason", () => {
    expect(parseDecisionInput({ outcome: "SELECTED", rationale: "Great trial shift" })).toEqual({ ok: true, value: { outcome: "SELECTED", rationale: "Great trial shift" } });
    expect(parseDecisionInput({ outcome: "HIRED", rationale: "ok then" }).ok).toBe(false);
    expect(parseDecisionInput({ outcome: "REJECTED", rationale: " " }).ok).toBe(false);
  });
  it("needs a reason to cancel", () => {
    expect(parseCancelReason("  ").ok).toBe(false);
    expect(parseCancelReason("Candidate asked to move it")).toEqual({ ok: true, value: "Candidate asked to move it" });
  });
});

describe("how interviews move an application", () => {
  it("schedules only for open applications, and moves early stages to Interview scheduled", () => {
    expect(canScheduleFor("SHORTLISTED")).toBe(true);
    expect(canScheduleFor("INTERVIEW_COMPLETED")).toBe(true);
    for (const s of ["SELECTED", "REJECTED", "WITHDRAWN", "OFFER_ISSUED"] as const) expect(canScheduleFor(s)).toBe(false);
    expect(stageAfterScheduling("APPLIED")).toBe("INTERVIEW_SCHEDULED");
    expect(stageAfterScheduling("INTERVIEW_COMPLETED")).toBeNull(); // a further round does not move it back
  });
  it("moves on to Interview completed once nothing is scheduled and at least one interview was completed", () => {
    expect(stageAfterInterviewEnded("INTERVIEW_SCHEDULED", 0, 1)).toBe("INTERVIEW_COMPLETED");
    expect(stageAfterInterviewEnded("INTERVIEW_SCHEDULED", 1, 1)).toBeNull();
    expect(stageAfterInterviewEnded("INTERVIEW_SCHEDULED", 0, 0)).toBeNull(); // only no-shows and cancellations
    expect(stageAfterInterviewEnded("SHORTLISTED", 0, 1)).toBeNull();
  });
  it("lets an interview be edited only until it starts", () => {
    expect(canEditInterview("SCHEDULED", new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(canEditInterview("SCHEDULED", now, now)).toBe(false);
    expect(canEditInterview("COMPLETED", new Date(now.getTime() + 60_000), now)).toBe(false);
  });
  it("refuses On hold for a Selected or closed application", () => {
    expect(onHoldRefusal("INTERVIEW_COMPLETED")).toBeNull();
    expect(onHoldRefusal("SELECTED")).toMatch(/move it back/);
    expect(onHoldRefusal("REJECTED")).toMatch(/Reopen/);
  });
  it("Selected and Rejected move the application; On hold leaves it", () => {
    expect(stageForDecision("SELECTED")).toBe("SELECTED");
    expect(stageForDecision("REJECTED")).toBe("REJECTED");
    expect(stageForDecision("ON_HOLD")).toBeNull();
  });
  it("opens feedback and outcomes only once the interview has started", () => {
    const later = new Date(now.getTime() + 60_000);
    expect(feedbackOpen("SCHEDULED", later, now)).toBe(false);
    expect(feedbackOpen("SCHEDULED", now, now)).toBe(true);
    expect(feedbackOpen("COMPLETED", now, now)).toBe(true);
    expect(feedbackOpen("CANCELLED", now, now)).toBe(false);
    expect(canRecordOutcome("SCHEDULED", later, now)).toBe(false);
    expect(canRecordOutcome("COMPLETED", now, now)).toBe(false);
  });
});
