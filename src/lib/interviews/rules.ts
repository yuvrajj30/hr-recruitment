import { z } from "zod";
import { type AnyStage, MAX_REASON_LENGTH, type PipelineStage } from "@/lib/recruitment/stages";

// Interviews and feedback: what a person types, checked before anything reaches the database, plus the
// rules for how interviews move an application through the pipeline. Pure functions only (no database,
// no Next.js), so every rule here is unit tested. The database enforces the same rules again
// (migrations 20261118000000_interviews_feedback and 20261118010000_interviews_review_fixes); these give
// people clear messages first.
//
// Who takes part: Super Admins and HR Managers only. There is no Interviewer role, and the candidate
// privacy notice tells applicants that only HR staff see their details.

export const INTERVIEW_TYPES = ["IN_PERSON", "ONLINE", "PHONE"] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];
export const INTERVIEW_STATUSES = ["SCHEDULED", "COMPLETED", "NO_SHOW", "CANCELLED"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
export const RECOMMENDATIONS = ["STRONGLY_RECOMMEND", "RECOMMEND", "HOLD", "REJECT"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export const DECISION_OUTCOMES = ["SELECTED", "ON_HOLD", "REJECTED"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = { IN_PERSON: "In person", ONLINE: "Online", PHONE: "Phone" };
export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
  CANCELLED: "Cancelled",
};
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  STRONGLY_RECOMMEND: "Strongly recommend",
  RECOMMEND: "Recommend",
  HOLD: "Not sure yet",
  REJECT: "Do not recommend",
};
export const DECISION_LABELS: Record<DecisionOutcome, string> = { SELECTED: "Selected", ON_HOLD: "On hold", REJECTED: "Rejected" };

// The scores an interviewer may give, each 1 (poor) to 5 (excellent). Only the overall rating is required.
export const RATING_CRITERIA = [
  { key: "technicalKnowledge", label: "Job knowledge and skills" },
  { key: "communication", label: "Communication" },
  { key: "problemSolving", label: "Problem solving" },
  { key: "confidence", label: "Confidence" },
  { key: "relevantExperience", label: "Relevant experience" },
  { key: "roleSuitability", label: "Fit for the role" },
] as const;
export type RatingKey = (typeof RATING_CRITERIA)[number]["key"] | "overallRating";
export const RATING_LABELS: Record<number, string> = { 1: "1 · Poor", 2: "2 · Below expectations", 3: "3 · Meets expectations", 4: "4 · Good", 5: "5 · Excellent" };

export const INTERVIEW_LIMITS = {
  roundName: 120,
  meetingLink: 500,
  location: 300,
  instructions: 4000,
  cancelReason: 1000,
  feedbackText: 4000,
  // A rejection's reason is also kept as the application's rejection reason and in its stage history, which
  // allow the same length.
  rationale: MAX_REASON_LENGTH,
  maxParticipants: 10,
  minDurationMinutes: 15,
  maxDurationMinutes: 480,
  maxDaysAhead: 365,
} as const;

export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240] as const;

// ---------------------------------------------------------------------------
// Time: the form shows the organisation's local time; the database stores the exact moment.
// ---------------------------------------------------------------------------

// "2026-11-20T15:30" (wall-clock time in `timeZone`) -> the exact moment, or null when it is not a real time.
export function zonedInputToDate(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(guess);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // 31 June and the like
  const first = guess - offsetMs(new Date(guess), timeZone);
  // Around a daylight-saving change the offset differs at the corrected moment; correct once more.
  const result = new Date(guess - offsetMs(new Date(first), timeZone));
  // A time skipped when the clocks go forward (02:30 on a spring-forward night) does not exist there:
  // refuse it rather than silently moving it by an hour.
  const pad = (n: number) => String(n).padStart(2, "0");
  if (dateToZonedInput(result, timeZone) !== `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`) return null;
  return result;
}

// The exact moment -> "2026-11-20T15:30" in `timeZone` (for an <input type="datetime-local">).
export function dateToZonedInput(moment: Date, timeZone: string): string {
  const p = zonedParts(moment, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function zonedParts(moment: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(moment);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function offsetMs(moment: Date, timeZone: string): number {
  const p = zonedParts(moment, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(moment.getTime() / 1000) * 1000;
}

// ---------------------------------------------------------------------------
// Scheduling and rescheduling
// ---------------------------------------------------------------------------

const optionalText = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine((v) => v.length <= max, `${label} must be ${max} characters or fewer.`)
    .transform((v) => (v === "" ? null : v));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScheduleInput = {
  type: InterviewType;
  start: Date;
  end: Date;
  roundName: string | null;
  meetingLink: string | null;
  location: string | null;
  instructions: string | null;
  participantIds: string[];
};

export type ScheduleFields = {
  type?: string;
  start?: string;
  duration?: string;
  roundName?: string;
  meetingLink?: string;
  location?: string;
  instructions?: string;
  participantIds?: string[];
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const scheduleSchema = z.object({
  type: z.enum(INTERVIEW_TYPES, "Choose how the interview happens."),
  start: z.string().trim().min(1, "Choose the date and time."),
  duration: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "Choose how long the interview lasts.")
    .transform(Number)
    .refine((n) => n >= INTERVIEW_LIMITS.minDurationMinutes && n <= INTERVIEW_LIMITS.maxDurationMinutes, "Choose how long the interview lasts."),
  roundName: optionalText(INTERVIEW_LIMITS.roundName, "The round name"),
  meetingLink: optionalText(INTERVIEW_LIMITS.meetingLink, "The meeting link"),
  location: optionalText(INTERVIEW_LIMITS.location, "The location"),
  instructions: optionalText(INTERVIEW_LIMITS.instructions, "The notes for interviewers"),
  participantIds: z.array(z.string()).default([]),
});

// `now` and `timeZone` come from the server: the start must be in the future, in the organisation's time.
// When editing, `requireFuture: false` lets an unchanged start that has already passed through (the service
// then requires the future only if the time actually changes).
export function parseScheduleInput(raw: ScheduleFields, opts: { timeZone: string; now: Date; requireFuture?: boolean }): Parsed<ScheduleInput> {
  const r = scheduleSchema.safeParse(raw);
  const errors: Record<string, string> = {};
  if (!r.success) {
    for (const issue of r.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
  }
  const v = r.success ? r.data : null;
  let start: Date | null = null;
  if (!errors.start && raw.start) {
    start = zonedInputToDate(raw.start, opts.timeZone);
    if (!start) errors.start = "Enter a real date and time.";
    else if (opts.requireFuture !== false && start.getTime() <= opts.now.getTime()) errors.start = "Choose a time in the future.";
    else if (start.getTime() > opts.now.getTime() + INTERVIEW_LIMITS.maxDaysAhead * 86_400_000) errors.start = "Choose a time within the next year.";
  }
  if (v) {
    if (v.type === "ONLINE") {
      if (!v.meetingLink) errors.meetingLink = "Add the link people use to join.";
      else if (!/^https:\/\/\S+$/.test(v.meetingLink)) errors.meetingLink = "The link must start with https:// and contain no spaces.";
      else if (!isWebAddress(v.meetingLink)) errors.meetingLink = "Enter a valid web address.";
    }
    if (v.type === "IN_PERSON" && !v.location) errors.location = "Say where the interview takes place.";
    const ids = [...new Set(v.participantIds.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) errors.participantIds = "Choose at least one interviewer.";
    else if (ids.length > INTERVIEW_LIMITS.maxParticipants) errors.participantIds = `Choose at most ${INTERVIEW_LIMITS.maxParticipants} interviewers.`;
    else if (ids.some((id) => !UUID.test(id))) errors.participantIds = "Choose interviewers from the list.";
    if (Object.keys(errors).length === 0 && start) {
      return {
        ok: true,
        value: {
          type: v.type,
          start,
          end: new Date(start.getTime() + v.duration * 60_000),
          roundName: v.roundName,
          // Only the fields that belong to the chosen kind of interview are kept.
          meetingLink: v.type === "ONLINE" ? v.meetingLink : null,
          location: v.type === "IN_PERSON" ? v.location : null,
          instructions: v.instructions,
          participantIds: ids,
        },
      };
    }
  }
  return { ok: false, errors };
}

function isWebAddress(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function formDataToScheduleFields(formData: FormData): ScheduleFields {
  const one = (key: string): string | undefined => {
    const v = formData.getAll(key);
    return v.length === 1 && typeof v[0] === "string" ? v[0] : undefined;
  };
  return {
    type: one("type"),
    start: one("start"),
    duration: one("duration"),
    roundName: one("roundName"),
    meetingLink: one("meetingLink"),
    location: one("location"),
    instructions: one("instructions"),
    participantIds: formData.getAll("participantIds").filter((x): x is string => typeof x === "string"),
  };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export type FeedbackInput = {
  ratings: Partial<Record<RatingKey, number | null>>;
  strengths: string | null;
  weaknesses: string | null;
  notes: string | null;
  recommendation: Recommendation | null;
};

export type FeedbackFields = Partial<Record<RatingKey | "strengths" | "weaknesses" | "notes" | "recommendation", string>>;

const RATING_KEYS: RatingKey[] = [...RATING_CRITERIA.map((c) => c.key), "overallRating"];

// A draft may be incomplete; a submission needs the overall rating and a recommendation (and cannot be
// changed afterwards).
export function parseFeedbackInput(raw: FeedbackFields, intent: "draft" | "submit"): Parsed<FeedbackInput> {
  const errors: Record<string, string> = {};
  const ratings: FeedbackInput["ratings"] = {};
  for (const key of RATING_KEYS) {
    const v = (raw[key] ?? "").trim();
    if (v === "") ratings[key] = null;
    else if (/^[1-5]$/.test(v)) ratings[key] = Number(v);
    else errors[key] = "Choose a score from 1 to 5.";
  }
  const text = (key: "strengths" | "weaknesses" | "notes"): string | null => {
    const v = (raw[key] ?? "").trim();
    if (v.length > INTERVIEW_LIMITS.feedbackText) errors[key] = `Keep this under ${INTERVIEW_LIMITS.feedbackText} characters.`;
    return v === "" ? null : v;
  };
  const strengths = text("strengths");
  const weaknesses = text("weaknesses");
  const notes = text("notes");
  const rec = (raw.recommendation ?? "").trim();
  let recommendation: Recommendation | null = null;
  if (rec !== "") {
    if ((RECOMMENDATIONS as readonly string[]).includes(rec)) recommendation = rec as Recommendation;
    else errors.recommendation = "Choose a recommendation from the list.";
  }
  if (intent === "submit") {
    if (ratings.overallRating == null && !errors.overallRating) errors.overallRating = "Give an overall score before submitting.";
    if (!recommendation && !errors.recommendation) errors.recommendation = "Choose your recommendation before submitting.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { ratings, strengths, weaknesses, notes, recommendation } };
}

export function formDataToFeedbackFields(formData: FormData): FeedbackFields {
  const out: FeedbackFields = {};
  for (const key of [...RATING_KEYS, "strengths", "weaknesses", "notes", "recommendation"] as const) {
    const v = formData.getAll(key);
    if (v.length === 1 && typeof v[0] === "string") out[key] = v[0];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DecisionInput = { outcome: DecisionOutcome; rationale: string };

export function parseDecisionInput(raw: { outcome?: string; rationale?: string }): Parsed<DecisionInput> {
  const errors: Record<string, string> = {};
  const outcome = (raw.outcome ?? "").trim();
  if (!(DECISION_OUTCOMES as readonly string[]).includes(outcome)) errors.outcome = "Choose a decision.";
  const rationale = (raw.rationale ?? "").trim();
  if (rationale.length < 3) errors.rationale = "Say briefly why (the candidate does not see this).";
  else if (rationale.length > INTERVIEW_LIMITS.rationale) errors.rationale = `Keep the reason under ${INTERVIEW_LIMITS.rationale} characters.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { outcome: outcome as DecisionOutcome, rationale } };
}

export function parseCancelReason(raw: string | null | undefined): Parsed<string> {
  const reason = (raw ?? "").trim();
  if (reason.length < 3) return { ok: false, errors: { reason: "Say why the interview is cancelled." } };
  if (reason.length > INTERVIEW_LIMITS.cancelReason) return { ok: false, errors: { reason: `Keep the reason under ${INTERVIEW_LIMITS.cancelReason} characters.` } };
  return { ok: true, value: reason };
}

// ---------------------------------------------------------------------------
// The pipeline: which stage an application moves to as interviews happen
// ---------------------------------------------------------------------------

// Stages in which an interview may be scheduled (the database checks the same list).
export const INTERVIEWABLE_STAGES = ["APPLIED", "UNDER_REVIEW", "SHORTLISTED", "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED"] as const;
export const canScheduleFor = (stage: AnyStage): boolean => (INTERVIEWABLE_STAGES as readonly string[]).includes(stage);

// Scheduling an interview moves an application that has not reached the interview stages yet.
export function stageAfterScheduling(stage: AnyStage): PipelineStage | null {
  return stage === "APPLIED" || stage === "UNDER_REVIEW" || stage === "SHORTLISTED" ? "INTERVIEW_SCHEDULED" : null;
}

// When an interview ends (completed, no-show or cancelled): once nothing is scheduled any more and at least
// one interview was completed, "Interview scheduled" moves on to "Interview completed".
export function stageAfterInterviewEnded(stage: AnyStage, stillScheduled: number, completed: number): PipelineStage | null {
  return stage === "INTERVIEW_SCHEDULED" && stillScheduled === 0 && completed > 0 ? "INTERVIEW_COMPLETED" : null;
}

// An interview's time and interviewers can change only until it starts (then: cancel and schedule a new round).
export function canEditInterview(status: InterviewStatus, start: Date, now: Date): boolean {
  return status === "SCHEDULED" && start.getTime() > now.getTime();
}

// "On hold" keeps the application in its stage, so it cannot be recorded for an application already Selected
// (or closed): move it back first. Returns the reason it is refused, or null.
export function onHoldRefusal(stage: AnyStage): string | null {
  if (stage === "SELECTED") return "This application is Selected. To put it on hold, first move it back to Interview completed (Status, on this page).";
  if (stage === "REJECTED" || stage === "WITHDRAWN") return "This application is closed. Reopen it first to put it on hold.";
  return null;
}

// What a decision does to the application: Selected and Rejected move it; On hold leaves it where it is.
export function stageForDecision(outcome: DecisionOutcome): PipelineStage | null {
  return outcome === "SELECTED" ? "SELECTED" : outcome === "REJECTED" ? "REJECTED" : null;
}

// Feedback can be written once the interview has started, while it is scheduled or completed.
export function feedbackOpen(status: InterviewStatus, start: Date, now: Date): boolean {
  return (status === "SCHEDULED" || status === "COMPLETED") && start.getTime() <= now.getTime();
}

// An interview can be marked completed or no-show once it has started.
export function canRecordOutcome(status: InterviewStatus, start: Date, now: Date): boolean {
  return status === "SCHEDULED" && start.getTime() <= now.getTime();
}
