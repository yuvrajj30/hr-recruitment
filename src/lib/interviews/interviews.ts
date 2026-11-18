import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { AuthError, ForbiddenError } from "@/lib/auth/errors";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { applicationScope, isUuid, listAssignableRecruiters } from "@/lib/recruitment/applications";
import { conflict, invalid, notFound, RecruitmentError } from "@/lib/recruitment/errors";
import { type AnyStage, checkMove, type PipelineStage, STAGE_LABELS } from "@/lib/recruitment/stages";
import {
  canEditInterview,
  canScheduleFor,
  type DecisionInput,
  type DecisionOutcome,
  type FeedbackInput,
  type InterviewStatus,
  type InterviewType,
  onHoldRefusal,
  type Recommendation,
  type ScheduleInput,
  stageAfterInterviewEnded,
  stageAfterScheduling,
  stageForDecision,
} from "./rules";

// Everything that reads or changes interviews, interview feedback and hiring decisions.
//
// The same rules as the rest of recruitment apply here:
//   - permission first, then the organisation from the server-side session (never from the browser);
//   - every query goes through staffDb, so PostgreSQL row-level security checks who is asking as well;
//   - plain values out, and an audit row inside the same transaction as each change.
// The database adds its own guards (migration 20261118000000_interviews_feedback): who may take part, what
// may change, feedback independence and locking. Its refusals are turned into clear messages here.

export type InterviewDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
};

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Database refusals -> messages for people
// ---------------------------------------------------------------------------

const DB_REFUSALS: [string, () => Error][] = [
  ["interview_in_past", () => invalid("Choose a time in the future.", { start: "Choose a time in the future." })],
  ["application_not_open", () => invalid("Interviews can only be scheduled for open applications.")],
  ["interview_closed", () => conflict("This interview is no longer scheduled, so it cannot be changed. Reload to see its current state.")],
  ["interview_not_started", () => invalid("An interview can be marked completed or no-show only once it has started.")],
  ["interviewer_not_eligible", () => invalid("Interviewers must be active HR Managers or Super Admins.", { participantIds: "Choose interviewers from the list." })],
  ["participant_has_feedback", () => invalid("Someone who has started their feedback cannot be removed from the interview.")],
  ["feedback_submitted", () => conflict("This feedback has already been submitted and cannot be changed.")],
  ["feedback_not_open", () => invalid("Feedback can be given once the interview has started, and not for a cancelled or no-show interview.")],
  ["decision_needs_interview", () => invalid("Record a decision after at least one interview has been completed.")],
  ["interviews_one_active_per_round", () => conflict("Someone else scheduled an interview for this application at the same moment. Reload and try again.")],
  ["interview_started", () => invalid("This interview has already started, so its time and interviewers can no longer change. Cancel it and schedule a new round if needed.")],
  ["candidate_removed", () => notFound("That candidate")],
  // The same interviewer saving their first feedback from two windows at once.
  ["interview_feedback_organization_id_participant_id_key", () => conflict("Your feedback was just saved from another window. Reload to see it.")],
];

function translateDbError(error: unknown): never {
  const text = `${String((error as Error)?.message ?? "")} ${JSON.stringify((error as { meta?: unknown })?.meta ?? "")}`;
  // Prisma reports a unique clash (P2002) by its columns rather than the index name.
  if ((error as { code?: unknown } | null)?.code === "P2002") {
    if (text.includes("participant_id")) throw conflict("Your feedback was just saved from another window. Reload to see it.");
    if (text.includes("round_number")) throw conflict("Someone else scheduled an interview for this application at the same moment. Reload and try again.");
  }
  for (const [needle, make] of DB_REFUSALS) if (text.includes(needle)) throw make();
  if (/not allowed|row-level security|permission denied/i.test(text)) throw new ForbiddenError("refused by the database");
  throw error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RecruitmentError || error instanceof AuthError) throw error;
    return translateDbError(error);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function requireInterviewRead(ctx: AuthContext): string {
  const organizationId = requireOrganizationId(ctx);
  requirePermission(ctx, "interview:read");
  return organizationId;
}

// Interviews of applications whose candidate was removed are left out everywhere (like their applications).
const interviewScope = (organizationId: string): Prisma.InterviewWhereInput => ({
  organizationId,
  application: { organizationCandidate: { removedAt: null } },
});

export const INTERVIEW_VIEWS = ["upcoming", "mine", "feedback", "past", "all"] as const;
export type InterviewView = (typeof INTERVIEW_VIEWS)[number];
export const INTERVIEW_VIEW_LABELS: Record<InterviewView, string> = {
  upcoming: "Upcoming",
  mine: "My interviews",
  feedback: "Awaiting my feedback",
  past: "Past",
  all: "All",
};

export type InterviewListItem = {
  id: string;
  roundNumber: number;
  roundName: string | null;
  type: InterviewType;
  status: InterviewStatus;
  start: Date;
  end: Date;
  application: { id: string; referenceNumber: string; stage: AnyStage };
  candidateName: string;
  jobTitle: string;
  participants: { userId: string; name: string }[];
  isParticipant: boolean;
  myFeedback: "none" | "draft" | "submitted" | null; // null: not a participant
};

const listSelect = {
  id: true,
  roundNumber: true,
  roundName: true,
  type: true,
  status: true,
  scheduledStart: true,
  scheduledEnd: true,
  application: {
    select: {
      id: true,
      referenceNumber: true,
      stage: true,
      job: { select: { title: true } },
      organizationCandidate: { select: { candidate: { select: { fullName: true } } } },
    },
  },
  participants: {
    select: { id: true, interviewerId: true, interviewer: { select: { user: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.InterviewSelect;

type ListRow = Prisma.InterviewGetPayload<{ select: typeof listSelect }>;

function toListItem(row: ListRow, me: string, myFeedback: Map<string, "draft" | "submitted">): InterviewListItem {
  const mine = row.participants.find((p) => p.interviewerId === me);
  return {
    id: row.id,
    roundNumber: row.roundNumber,
    roundName: row.roundName,
    type: row.type,
    status: row.status,
    start: row.scheduledStart,
    end: row.scheduledEnd,
    application: { id: row.application.id, referenceNumber: row.application.referenceNumber, stage: row.application.stage },
    candidateName: row.application.organizationCandidate.candidate.fullName,
    jobTitle: row.application.job.title,
    participants: row.participants.map((p) => ({ userId: p.interviewerId, name: p.interviewer.user.name })),
    isParticipant: Boolean(mine),
    myFeedback: mine ? (myFeedback.get(mine.id) ?? "none") : null,
  };
}

// The caller's own feedback state for these participant rows (their own rows are always visible to them).
async function myFeedbackStates(db: Db, organizationId: string, me: string, participantIds: string[]): Promise<Map<string, "draft" | "submitted">> {
  if (participantIds.length === 0) return new Map();
  const rows = await db.interviewFeedback.findMany({
    where: { organizationId, interviewerId: me, participantId: { in: participantIds } },
    select: { participantId: true, submittedAt: true },
  });
  return new Map(rows.map((r) => [r.participantId, r.submittedAt ? "submitted" : "draft"]));
}

export const INTERVIEW_PAGE_SIZE = 50;

export async function listInterviews(
  rawDb: Db,
  ctx: AuthContext,
  filters: { view: InterviewView; page?: number },
  now: Date,
): Promise<{ items: InterviewListItem[]; total: number; page: number; pageSize: number; counts: Record<"upcoming" | "feedback", number> }> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const organizationId = requireInterviewRead(ctx);
  const me = ctx.user.id;
  const base = interviewScope(organizationId);
  const imParticipant: Prisma.InterviewWhereInput = { participants: { some: { interviewerId: me } } };
  // Started, still open for feedback, and my feedback is not submitted yet.
  const awaitingMine: Prisma.InterviewWhereInput = {
    status: { in: ["SCHEDULED", "COMPLETED"] },
    scheduledStart: { lte: now },
    participants: { some: { interviewerId: me, OR: [{ feedback: { is: null } }, { feedback: { is: { submittedAt: null } } }] } },
  };
  const upcoming: Prisma.InterviewWhereInput = { status: "SCHEDULED", scheduledEnd: { gte: now } };
  const byView: Record<InterviewView, { where: Prisma.InterviewWhereInput; order: "asc" | "desc" }> = {
    upcoming: { where: upcoming, order: "asc" },
    mine: { where: { ...imParticipant, status: { in: ["SCHEDULED", "COMPLETED"] } }, order: "desc" },
    feedback: { where: awaitingMine, order: "asc" },
    past: { where: { OR: [{ status: { not: "SCHEDULED" } }, { scheduledEnd: { lt: now } }] }, order: "desc" },
    all: { where: {}, order: "desc" },
  };
  const { where, order } = byView[filters.view];
  const page = Math.max(1, Math.min(Math.floor(filters.page ?? 1) || 1, 1000));
  const full: Prisma.InterviewWhereInput = { AND: [base, where] };
  const [rows, total, upcomingCount, feedbackCount] = await Promise.all([
    db.interview.findMany({
      where: full,
      select: listSelect,
      orderBy: [{ scheduledStart: order }, { id: "asc" }],
      skip: (page - 1) * INTERVIEW_PAGE_SIZE,
      take: INTERVIEW_PAGE_SIZE,
    }),
    db.interview.count({ where: full }),
    db.interview.count({ where: { AND: [base, upcoming] } }),
    db.interview.count({ where: { AND: [base, awaitingMine] } }),
  ]);
  const mineIds = rows.flatMap((r) => r.participants.filter((p) => p.interviewerId === me).map((p) => p.id));
  const states = await myFeedbackStates(db, organizationId, me, mineIds);
  return {
    items: rows.map((r) => toListItem(r, me, states)),
    total,
    page,
    pageSize: INTERVIEW_PAGE_SIZE,
    counts: { upcoming: upcomingCount, feedback: feedbackCount },
  };
}

// The interviews of one application (on the application page) or of one candidate (on the candidate page).
export async function listInterviewsFor(rawDb: Db, ctx: AuthContext, target: { applicationId: string } | { organizationCandidateId: string }): Promise<InterviewListItem[]> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const organizationId = requireInterviewRead(ctx);
  const id = "applicationId" in target ? target.applicationId : target.organizationCandidateId;
  if (!isUuid(id)) return [];
  const where: Prisma.InterviewWhereInput =
    "applicationId" in target ? { applicationId: target.applicationId } : { application: { organizationCandidateId: target.organizationCandidateId } };
  const rows = await db.interview.findMany({
    where: { AND: [interviewScope(organizationId), where] },
    select: listSelect,
    orderBy: [{ scheduledStart: "desc" }],
    take: 100,
  });
  const me = ctx.user.id;
  const states = await myFeedbackStates(db, organizationId, me, rows.flatMap((r) => r.participants.filter((p) => p.interviewerId === me).map((p) => p.id)));
  return rows.map((r) => toListItem(r, me, states));
}

export type FeedbackView = {
  participantId: string;
  interviewerName: string;
  isMine: boolean;
  ratings: Record<string, number | null>;
  overallRating: number | null;
  strengths: string | null;
  weaknesses: string | null;
  notes: string | null;
  recommendation: Recommendation | null;
  submittedAt: Date | null;
  updatedAt: Date;
};

export type InterviewDetail = InterviewListItem & {
  meetingLink: string | null;
  location: string | null;
  instructions: string | null;
  cancelReason: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  participantRows: { participantId: string; userId: string; name: string; isMe: boolean }[];
  myParticipantId: string | null;
  myFeedback: "none" | "draft" | "submitted" | null;
  myFeedbackRow: FeedbackView | null;
  // Colleagues' SUBMITTED feedback the caller may see. The database hides it until the caller, if they
  // interviewed too, has submitted their own (and needs feedback:read).
  otherFeedback: FeedbackView[];
  othersHiddenUntilISubmit: boolean;
  candidateId: string;
};

const feedbackSelect = {
  participantId: true,
  interviewerId: true,
  technicalKnowledge: true,
  communication: true,
  problemSolving: true,
  confidence: true,
  relevantExperience: true,
  roleSuitability: true,
  overallRating: true,
  strengths: true,
  weaknesses: true,
  notes: true,
  recommendation: true,
  submittedAt: true,
  updatedAt: true,
  interviewer: { select: { name: true } },
} satisfies Prisma.InterviewFeedbackSelect;

type FeedbackRow = Prisma.InterviewFeedbackGetPayload<{ select: typeof feedbackSelect }>;

const toFeedbackView = (f: FeedbackRow, me: string): FeedbackView => ({
  participantId: f.participantId,
  interviewerName: f.interviewer.name,
  isMine: f.interviewerId === me,
  ratings: {
    technicalKnowledge: f.technicalKnowledge,
    communication: f.communication,
    problemSolving: f.problemSolving,
    confidence: f.confidence,
    relevantExperience: f.relevantExperience,
    roleSuitability: f.roleSuitability,
  },
  overallRating: f.overallRating,
  strengths: f.strengths,
  weaknesses: f.weaknesses,
  notes: f.notes,
  recommendation: f.recommendation,
  submittedAt: f.submittedAt,
  updatedAt: f.updatedAt,
});

export async function getInterview(rawDb: Db, ctx: AuthContext, interviewId: string): Promise<InterviewDetail> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const organizationId = requireInterviewRead(ctx);
  if (!isUuid(interviewId)) throw notFound("That interview");
  const row = await db.interview.findFirst({
    where: { AND: [interviewScope(organizationId), { id: interviewId }] },
    select: {
      ...listSelect,
      meetingLink: true,
      location: true,
      instructions: true,
      cancelReason: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
      application: { select: { ...listSelect.application.select, organizationCandidateId: true } },
    },
  });
  if (!row) throw notFound("That interview");
  const me = ctx.user.id;
  const myParticipant = row.participants.find((p) => p.interviewerId === me) ?? null;
  // Row-level security returns only the feedback this person may see: their own (draft or submitted) and,
  // with feedback:read, colleagues' submitted feedback once their own is in.
  const canReadOthers = ctx.permissions.has("feedback:read");
  const feedback = await db.interviewFeedback.findMany({
    where: { organizationId, participantId: { in: row.participants.map((p) => p.id) }, ...(canReadOthers ? {} : { interviewerId: me }) },
    select: feedbackSelect,
    orderBy: { submittedAt: "asc" },
  });
  const mine = feedback.find((f) => f.interviewerId === me) ?? null;
  const myState = myParticipant ? (mine ? (mine.submittedAt ? "submitted" : "draft") : "none") : null;
  const states = new Map<string, "draft" | "submitted">(mine && myParticipant ? [[myParticipant.id, mine.submittedAt ? "submitted" : "draft"]] : []);
  return {
    ...toListItem(row, me, states),
    meetingLink: row.meetingLink,
    location: row.location,
    instructions: row.instructions,
    cancelReason: row.cancelReason,
    createdByName: row.createdBy?.name ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    participantRows: row.participants.map((p) => ({ participantId: p.id, userId: p.interviewerId, name: p.interviewer.user.name, isMe: p.interviewerId === me })),
    myParticipantId: myParticipant?.id ?? null,
    myFeedback: myState,
    myFeedbackRow: mine ? toFeedbackView(mine, me) : null,
    otherFeedback: feedback.filter((f) => f.interviewerId !== me && f.submittedAt).map((f) => toFeedbackView(f, me)),
    // Only while feedback can still be written (the database relaxes the rule once an interview ended as a
    // no-show or was cancelled).
    othersHiddenUntilISubmit: Boolean(myParticipant) && myState !== "submitted" && row.participants.length > 1 && (row.status === "SCHEDULED" || row.status === "COMPLETED"),
    candidateId: row.application.organizationCandidateId,
  };
}

export type DecisionView = { outcome: DecisionOutcome; rationale: string | null; decidedByName: string; decidedAt: Date };

export async function getDecision(rawDb: Db, ctx: AuthContext, applicationId: string): Promise<DecisionView | null> {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  const organizationId = requireOrganizationId(ctx);
  requirePermission(ctx, "decision:read");
  if (!isUuid(applicationId)) return null;
  const row = await db.hiringDecision.findFirst({
    where: { organizationId, applicationId, application: { organizationCandidate: { removedAt: null } } },
    select: { outcome: true, rationale: true, decidedAt: true, decidedBy: { select: { name: true } } },
  });
  return row ? { outcome: row.outcome, rationale: row.rationale, decidedByName: row.decidedBy.name, decidedAt: row.decidedAt } : null;
}

// Who can be chosen as an interviewer: active Super Admins and HR Managers (the same people who may be
// responsible for an application).
export async function listInterviewerOptions(rawDb: Db, ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  requireInterviewRead(ctx);
  return listAssignableRecruiters(rawDb, ctx);
}

// What the scheduling form needs to know about the application.
export async function getSchedulingTarget(rawDb: Db, ctx: AuthContext, applicationId: string) {
  const db = staffDb(rawDb, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "interview:schedule");
  if (!isUuid(applicationId)) throw notFound("That application");
  const app = await db.application.findFirst({
    where: { AND: [applicationScope(ctx), { id: applicationId }] },
    select: {
      id: true,
      referenceNumber: true,
      stage: true,
      job: { select: { title: true } },
      organizationCandidate: { select: { candidate: { select: { fullName: true } } } },
      interviews: { where: { status: { not: "CANCELLED" } }, select: { roundNumber: true } },
    },
  });
  if (!app) throw notFound("That application");
  return {
    id: app.id,
    referenceNumber: app.referenceNumber,
    stage: app.stage,
    jobTitle: app.job.title,
    candidateName: app.organizationCandidate.candidate.fullName,
    nextRound: Math.max(0, ...app.interviews.map((i) => i.roundNumber)) + 1,
    open: canScheduleFor(app.stage),
  };
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

// Moves the application inside the caller's transaction, the same way a manual move does (history row and
// audit row), but only when it is still in the stage we saw.
async function moveStageInTx(
  tx: Tx,
  deps: InterviewDeps,
  ctx: AuthContext,
  organizationId: string,
  applicationId: string,
  from: AnyStage,
  to: PipelineStage,
  reason: string | null,
  via: string,
): Promise<void> {
  const check = checkMove(from, to, reason);
  if (!check.ok) throw invalid(check.message);
  const updated = await tx.application.updateMany({
    where: { id: applicationId, organizationId, stage: from },
    data: { stage: to, stageChangedAt: deps.now, rejectionReason: to === "REJECTED" ? check.reason : null },
  });
  if (updated.count !== 1) throw conflict("This application was moved by someone else. Reload to see its current state.");
  await tx.applicationStatusHistory.create({
    data: { organizationId, applicationId, fromStage: from, toStage: to, changedById: ctx.user.id, reason: check.reason, createdAt: deps.now },
  });
  await deps.writeAudit(tx, {
    organizationId,
    actorUserId: ctx.user.id,
    action: "application.stage_changed",
    entityType: "application",
    entityId: applicationId,
    metadata: { from, to, kind: check.kind, via },
    ...deps.client,
    now: deps.now,
  });
}

async function checkInterviewers(db: Db, ctx: AuthContext, ids: string[]): Promise<void> {
  const eligible = new Set((await listAssignableRecruiters(db, ctx)).map((r) => r.id));
  if (ids.some((id) => !eligible.has(id))) {
    // Someone from another organisation, a suspended member, an Employee and a made-up id get the same answer.
    throw invalid("Interviewers must be active HR Managers or Super Admins of this organisation.", { participantIds: "Choose interviewers from the list." });
  }
}

export async function scheduleInterview(deps: InterviewDeps, ctx: AuthContext, applicationId: string, input: ScheduleInput): Promise<{ id: string }> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "interview:schedule");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  const app = await db.application.findFirst({ where: { AND: [applicationScope(ctx), { id: applicationId }] }, select: { stage: true } });
  if (!app) throw notFound("That application");
  if (!canScheduleFor(app.stage)) throw invalid(`An interview cannot be scheduled while the application is ${STAGE_LABELS[app.stage].toLowerCase()}.`);
  if (input.start.getTime() <= deps.now.getTime()) throw invalid("Choose a time in the future.", { start: "Choose a time in the future." });
  await checkInterviewers(db, ctx, input.participantIds);

  return guarded(() =>
    db.$transaction(async (tx) => {
      // The next round number. Two people scheduling at once would pick the same number; the database's
      // "one active interview per round" rule refuses the second, which is reported as a clash.
      const rounds = await tx.interview.findMany({ where: { organizationId, applicationId, status: { not: "CANCELLED" } }, select: { roundNumber: true } });
      const roundNumber = Math.max(0, ...rounds.map((r) => r.roundNumber)) + 1;
      if (roundNumber > 50) throw invalid("This application already has the maximum number of interview rounds.");
      const interview = await tx.interview.create({
        data: {
          organizationId,
          applicationId,
          roundNumber,
          roundName: input.roundName,
          type: input.type,
          status: "SCHEDULED",
          scheduledStart: input.start,
          scheduledEnd: input.end,
          meetingLink: input.meetingLink,
          location: input.location,
          instructions: input.instructions,
          createdById: ctx.user.id,
          createdAt: deps.now,
        },
        select: { id: true },
      });
      await tx.interviewParticipant.createMany({
        data: input.participantIds.map((interviewerId) => ({ organizationId, interviewId: interview.id, interviewerId, createdAt: deps.now })),
      });
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: "interview.scheduled",
        entityType: "interview",
        entityId: interview.id,
        metadata: { applicationId, round: roundNumber, type: input.type, interviewers: input.participantIds.length },
        ...deps.client,
        now: deps.now,
      });
      const next = stageAfterScheduling(app.stage);
      if (next) await moveStageInTx(tx, deps, ctx, organizationId, applicationId, app.stage, next, null, "interview_scheduled");
      return interview;
    }),
  );
}

async function loadScheduled(db: Db, organizationId: string, interviewId: string) {
  if (!isUuid(interviewId)) throw notFound("That interview");
  const row = await db.interview.findFirst({
    where: { AND: [interviewScope(organizationId), { id: interviewId }] },
    select: {
      id: true,
      status: true,
      scheduledStart: true,
      scheduledEnd: true,
      applicationId: true,
      participants: { select: { id: true, interviewerId: true } },
    },
  });
  if (!row) throw notFound("That interview");
  return row;
}

// Locks the application row for the rest of the transaction and returns its stage, so changes that move the
// application (an interview ending, a decision) on the same application run one after the other.
async function lockApplication(tx: Tx, organizationId: string, applicationId: string): Promise<AnyStage> {
  const rows = await tx.$queryRaw<{ stage: AnyStage }[]>`
    SELECT "stage"::text AS "stage" FROM "applications" WHERE "id" = ${applicationId}::uuid AND "organization_id" = ${organizationId}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound("That application");
  return rows[0].stage;
}

// After an interview ended (completed, no-show or cancelled): with nothing scheduled any more and at least one
// interview completed, "Interview scheduled" moves on to "Interview completed".
async function settleStageAfterInterview(tx: Tx, deps: InterviewDeps, ctx: AuthContext, organizationId: string, applicationId: string, stage: AnyStage, via: string): Promise<void> {
  const [stillScheduled, completed] = [
    await tx.interview.count({ where: { organizationId, applicationId, status: "SCHEDULED" } }),
    await tx.interview.count({ where: { organizationId, applicationId, status: "COMPLETED" } }),
  ];
  const next = stageAfterInterviewEnded(stage, stillScheduled, completed);
  if (next) await moveStageInTx(tx, deps, ctx, organizationId, applicationId, stage, next, null, via);
}

// Edit a scheduled interview that has not started yet (time, kind, place, notes, interviewers). Once it has
// started, who interviews and when are fixed (feedback may already be in): cancel and schedule a new round.
export async function updateInterview(deps: InterviewDeps, ctx: AuthContext, interviewId: string, input: ScheduleInput): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "interview:update");
  const organizationId = requireOrganizationId(ctx);
  const current = await loadScheduled(db, organizationId, interviewId);
  if (current.status !== "SCHEDULED") throw conflict("Only a scheduled interview can be changed.");
  if (!canEditInterview(current.status, current.scheduledStart, deps.now)) {
    throw invalid("This interview has already started, so it can no longer be changed. Record what happened, or cancel it and schedule a new round.");
  }
  const moved = current.scheduledStart.getTime() !== input.start.getTime() || current.scheduledEnd.getTime() !== input.end.getTime();
  if (moved && input.start.getTime() <= deps.now.getTime()) throw invalid("Choose a time in the future.", { start: "Choose a time in the future." });

  const keep = new Set(input.participantIds);
  const removed = current.participants.filter((p) => !keep.has(p.interviewerId));
  const have = new Set(current.participants.map((p) => p.interviewerId));
  const added = input.participantIds.filter((id) => !have.has(id));
  if (added.length > 0) await checkInterviewers(db, ctx, added);

  await guarded(() =>
    db.$transaction(async (tx) => {
      const updated = await tx.interview.updateMany({
        where: { id: interviewId, organizationId, status: "SCHEDULED" },
        data: {
          type: input.type,
          roundName: input.roundName,
          scheduledStart: input.start,
          scheduledEnd: input.end,
          meetingLink: input.meetingLink,
          location: input.location,
          instructions: input.instructions,
        },
      });
      if (updated.count !== 1) throw conflict("This interview was changed by someone else. Reload to see its current state.");
      if (removed.length > 0) await tx.interviewParticipant.deleteMany({ where: { organizationId, id: { in: removed.map((p) => p.id) } } });
      if (added.length > 0) {
        await tx.interviewParticipant.createMany({ data: added.map((interviewerId) => ({ organizationId, interviewId, interviewerId, createdAt: deps.now })) });
      }
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: moved ? "interview.rescheduled" : "interview.updated",
        entityType: "interview",
        entityId: interviewId,
        metadata: { interviewersAdded: added.length, interviewersRemoved: removed.length },
        ...deps.client,
        now: deps.now,
      });
    }),
  );
}

// Completed or no-show, once the interview has started. When the last scheduled interview ends and one was
// completed, the application moves from "Interview scheduled" to "Interview completed".
export async function recordInterviewOutcome(deps: InterviewDeps, ctx: AuthContext, interviewId: string, outcome: "COMPLETED" | "NO_SHOW"): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "interview:update");
  const organizationId = requireOrganizationId(ctx);
  const current = await loadScheduled(db, organizationId, interviewId);
  if (current.status !== "SCHEDULED") throw conflict("This interview is no longer scheduled. Reload to see its current state.");
  if (current.scheduledStart.getTime() > deps.now.getTime()) throw invalid("An interview can be marked completed or no-show only once it has started.");

  await guarded(() =>
    db.$transaction(async (tx) => {
      const stage = await lockApplication(tx, organizationId, current.applicationId);
      const updated = await tx.interview.updateMany({ where: { id: interviewId, organizationId, status: "SCHEDULED" }, data: { status: outcome } });
      if (updated.count !== 1) throw conflict("This interview was changed by someone else. Reload to see its current state.");
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: outcome === "COMPLETED" ? "interview.completed" : "interview.no_show",
        entityType: "interview",
        entityId: interviewId,
        metadata: { applicationId: current.applicationId },
        ...deps.client,
        now: deps.now,
      });
      await settleStageAfterInterview(tx, deps, ctx, organizationId, current.applicationId, stage, outcome === "COMPLETED" ? "interview_completed" : "interview_no_show");
    }),
  );
}

export async function cancelInterview(deps: InterviewDeps, ctx: AuthContext, interviewId: string, reason: string): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "interview:cancel");
  const organizationId = requireOrganizationId(ctx);
  const current = await loadScheduled(db, organizationId, interviewId);
  if (current.status !== "SCHEDULED") throw conflict("Only a scheduled interview can be cancelled.");
  await guarded(() =>
    db.$transaction(async (tx) => {
      const stage = await lockApplication(tx, organizationId, current.applicationId);
      const updated = await tx.interview.updateMany({ where: { id: interviewId, organizationId, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelReason: reason } });
      if (updated.count !== 1) throw conflict("This interview was changed by someone else. Reload to see its current state.");
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: "interview.cancelled",
        entityType: "interview",
        entityId: interviewId,
        metadata: { applicationId: current.applicationId, reasonLength: reason.length }, // the reason itself stays out of the audit log
        ...deps.client,
        now: deps.now,
      });
      await settleStageAfterInterview(tx, deps, ctx, organizationId, current.applicationId, stage, "interview_cancelled");
    }),
  );
}

// The caller's own feedback: saved as a draft (private to them) or submitted (final; colleagues then see it).
export async function saveFeedback(deps: InterviewDeps, ctx: AuthContext, interviewId: string, input: FeedbackInput, intent: "draft" | "submit"): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "feedback:submit");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(interviewId)) throw notFound("That interview");
  const interview = await db.interview.findFirst({
    where: { AND: [interviewScope(organizationId), { id: interviewId }] },
    select: { status: true, scheduledStart: true, participants: { where: { interviewerId: ctx.user.id }, select: { id: true } } },
  });
  if (!interview) throw notFound("That interview");
  const participant = interview.participants[0];
  if (!participant) throw invalid("Only the interviewers of this interview can give feedback on it.");
  if (!((interview.status === "SCHEDULED" || interview.status === "COMPLETED") && interview.scheduledStart.getTime() <= deps.now.getTime())) {
    throw invalid("Feedback can be given once the interview has started, and not for a cancelled or no-show interview.");
  }
  const data = {
    technicalKnowledge: input.ratings.technicalKnowledge ?? null,
    communication: input.ratings.communication ?? null,
    problemSolving: input.ratings.problemSolving ?? null,
    confidence: input.ratings.confidence ?? null,
    relevantExperience: input.ratings.relevantExperience ?? null,
    roleSuitability: input.ratings.roleSuitability ?? null,
    overallRating: input.ratings.overallRating ?? null,
    strengths: input.strengths,
    weaknesses: input.weaknesses,
    notes: input.notes,
    recommendation: input.recommendation,
    submittedAt: intent === "submit" ? deps.now : null,
  };

  await guarded(() =>
    db.$transaction(async (tx) => {
      const existing = await tx.interviewFeedback.findFirst({ where: { organizationId, participantId: participant.id }, select: { id: true, submittedAt: true } });
      if (existing?.submittedAt) throw conflict("Your feedback has already been submitted and cannot be changed.");
      if (existing) {
        const updated = await tx.interviewFeedback.updateMany({ where: { id: existing.id, organizationId, interviewerId: ctx.user.id, submittedAt: null }, data });
        if (updated.count !== 1) throw conflict("Your feedback has already been submitted and cannot be changed.");
      } else {
        await tx.interviewFeedback.create({ data: { ...data, organizationId, participantId: participant.id, interviewerId: ctx.user.id, createdAt: deps.now } });
      }
      if (intent === "submit") {
        await deps.writeAudit(tx, {
          organizationId,
          actorUserId: ctx.user.id,
          action: "feedback.submitted",
          entityType: "interview",
          entityId: interviewId,
          // Only that it was submitted: no scores or words, which colleagues must not see before submitting theirs
          // (the audit log is readable by Super Admins, who may be interviewers too).
          metadata: {},
          ...deps.client,
          now: deps.now,
        });
      }
    }),
  );
}

// Why this decision cannot be recorded for an application in `stage`, or null when it can.
function decisionRefusal(stage: AnyStage, input: DecisionInput): string | null {
  const target = stageForDecision(input.outcome);
  if (!target) return onHoldRefusal(stage);
  if (target === stage) return null;
  const check = checkMove(stage, target, input.rationale);
  if (check.ok) return null;
  return stage === "REJECTED" || stage === "WITHDRAWN"
    ? `This application is ${STAGE_LABELS[stage].toLowerCase()}. Reopen it first (Status, on the application) to record a different decision.`
    : check.message;
}

// Selected moves the application to "Selected"; Rejected rejects it (the reason is recorded as the rejection
// reason); On hold leaves it where it is (not possible once Selected: move it back first). A decision can be
// changed later; each change is audited. The decision and the stage always change together: the application
// row is locked and everything is checked again inside the transaction.
export async function recordDecision(deps: InterviewDeps, ctx: AuthContext, applicationId: string, input: DecisionInput): Promise<void> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "decision:make");
  const organizationId = requireOrganizationId(ctx);
  if (!isUuid(applicationId)) throw notFound("That application");
  if (input.outcome === "REJECTED") requirePermission(ctx, "application:move_stage");
  const app = await db.application.findFirst({
    where: { AND: [applicationScope(ctx), { id: applicationId }] },
    select: { stage: true, interviews: { where: { status: "COMPLETED" }, select: { id: true }, take: 1 } },
  });
  if (!app) throw notFound("That application");
  if (app.interviews.length === 0) throw invalid("Record a decision after at least one interview has been completed.");
  const early = decisionRefusal(app.stage, input);
  if (early) throw invalid(early);

  await guarded(() =>
    db.$transaction(async (tx) => {
      const stage = await lockApplication(tx, organizationId, applicationId);
      const refusal = decisionRefusal(stage, input);
      if (refusal) throw invalid(refusal);
      const previous = await tx.hiringDecision.findFirst({ where: { organizationId, applicationId }, select: { outcome: true } });
      await tx.hiringDecision.upsert({
        where: { organizationId_applicationId: { organizationId, applicationId } },
        create: { organizationId, applicationId, outcome: input.outcome, rationale: input.rationale, decidedById: ctx.user.id, decidedAt: deps.now },
        update: { outcome: input.outcome, rationale: input.rationale, decidedById: ctx.user.id, decidedAt: deps.now },
      });
      await deps.writeAudit(tx, {
        organizationId,
        actorUserId: ctx.user.id,
        action: previous ? "decision.changed" : "decision.recorded",
        entityType: "application",
        entityId: applicationId,
        metadata: { outcome: input.outcome, previous: previous?.outcome ?? null }, // the reason stays out of the audit log
        ...deps.client,
        now: deps.now,
      });
      const target = stageForDecision(input.outcome);
      if (target && target !== stage) {
        await moveStageInTx(tx, deps, ctx, organizationId, applicationId, stage, target, target === "REJECTED" ? input.rationale : null, "decision");
      }
    }),
  );
}
