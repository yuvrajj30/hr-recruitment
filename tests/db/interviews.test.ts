// Interviews, feedback and hiring decisions (migration 20261118000000_interviews_feedback), against the
// DISPOSABLE test database only. Two kinds of check:
//   - the services, called as the app's restricted account with real sessions (what the screens do), and
//   - direct SQL as the app's account, the way a bug or a forged request would try it, to prove the
//     database itself refuses (row-level security, triggers, missing rights).
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import {
  cancelInterview,
  getDecision,
  getInterview,
  type InterviewDeps,
  listInterviews,
  listInterviewsFor,
  recordDecision,
  recordInterviewOutcome,
  saveFeedback,
  scheduleInterview,
  updateInterview,
} from "@/lib/interviews/interviews";
import type { FeedbackInput, ScheduleInput } from "@/lib/interviews/rules";
import { getApplication, moveApplicationStage } from "@/lib/recruitment/applications";
import { removeCandidate } from "@/lib/recruitment/privacy";
import type { FileStorage } from "@/lib/recruitment/storage";
import { realRoleIds } from "./roles-helper";
import { giveSession, pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "interviews-test.example.test";
const HOUR = 3_600_000;

const feedback = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
  ratings: { communication: 4, overallRating: 4 },
  strengths: "Calm under pressure during the rush-hour role play.",
  weaknesses: null,
  notes: null,
  recommendation: "RECOMMEND",
  ...over,
});

describe.skipIf(!enabled)("interviews, feedback and decisions (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client; // owner connection, for fixtures and direct checks
  let rt: Client; // the app's account, for direct attempts
  let role: Record<RoleKey, string>;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 5 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    role = await realRoleIds(owner);
  });

  afterAll(async () => {
    if (owner && orgIds.length) {
      // Applications cascade to their stage history (whose guard blocks only UPDATE, so no table lock is
      // needed), interviews, participants, feedback and decisions (owner account).
      await owner.candidateDocument.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.application.deleteMany({ where: { organizationId: { in: orgIds } } });
      const profiles = (await owner.organizationCandidate.findMany({ where: { organizationId: { in: orgIds } }, select: { candidateId: true } })).map((r) => r.candidateId);
      await owner.organizationCandidate.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.candidateProfile.deleteMany({ where: { OR: [{ id: { in: profiles } }, { email: { endsWith: `@${DOMAIN}` } }] } });
      await owner.jobOpening.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds);
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await db?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  // One organisation: a Super Admin, two HR Managers and an Employee, a job, and one shortlisted application.
  async function world() {
    const user = async (name: string) => {
      const u = await owner.user.create({ data: { email: `${name.toLowerCase()}-${rnd()}@${DOMAIN}`, name } });
      userIds.push(u.id);
      return u;
    };
    const [saU, hrU, hr2U, empU] = [await user("Sana"), await user("Harish"), await user("Hema"), await user("Esha")];
    const org = await owner.organization.create({ data: { slug: `iv-${rnd()}${rnd()}`, name: `Interview Org ${rnd()}`, ownerUserId: saU.id, timezone: "Asia/Kolkata" } });
    orgIds.push(org.id);
    for (const [u, key] of [[saU, "SUPER_ADMIN"], [hrU, "HR_MANAGER"], [hr2U, "HR_MANAGER"], [empU, "EMPLOYEE"]] as const) {
      await owner.organizationMember.create({ data: { organizationId: org.id, userId: u.id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[key] }] } } });
    }
    const job = await owner.jobOpening.create({
      data: { organizationId: org.id, slug: `job-${rnd()}`, title: "Barista", description: "Test job.", employmentType: "FULL_TIME", workMode: "ON_SITE", createdById: saU.id, status: "PUBLISHED", publishedAt: new Date() },
    });
    const entries: AuditEntry[] = [];
    const files = new Map<string, Uint8Array>();
    const storage: FileStorage = { put: async (k, b) => void files.set(k, b), get: async (k) => files.get(k) ?? null, remove: async (k) => void files.delete(k) };
    const deps = (): InterviewDeps & { storage: FileStorage } => ({ db, now: new Date(), writeAudit: async (_d, e) => void entries.push(e), client: { ipAddress: null, userAgent: null }, storage });
    const ctx = (u: { id: string; email: string; name: string }, key: RoleKey): AuthContext => ({
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: u.id, email: u.email, name: u.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId: null,
      expiresAt: new Date(),
      absoluteExpiresAt: new Date(),
      roleKeys: [key],
      permissions: new Set(ROLE_PERMISSIONS[key]),
    });
    const application = async (stage: "SHORTLISTED" | "APPLIED" = "SHORTLISTED") => {
      const profile = await owner.candidateProfile.create({ data: { organizationId: org.id, email: `cand-${rnd()}@${DOMAIN}`, fullName: "Kavya Rao" } });
      const oc = await owner.organizationCandidate.create({ data: { organizationId: org.id, candidateId: profile.id, firstSeenAt: new Date() } });
      return owner.application.create({
        data: { organizationId: org.id, referenceNumber: `APP-T-${rnd().toUpperCase()}`, organizationCandidateId: oc.id, jobId: job.id, stage, stageChangedAt: new Date(), appliedAt: new Date(), ageConfirmedAt: new Date(), consentAcceptedAt: new Date(), privacyNoticeVersion: "test" },
      });
    };
    return {
      org, job, entries, deps, application, users: { sa: saU, hr: hrU, hr2: hr2U, emp: empU },
      sa: await giveSession(owner, ctx(saU, "SUPER_ADMIN")),
      hr: await giveSession(owner, ctx(hrU, "HR_MANAGER")),
      hr2: await giveSession(owner, ctx(hr2U, "HR_MANAGER")),
      emp: await giveSession(owner, ctx(empU, "EMPLOYEE")),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const slot = (hoursAhead: number, participantIds: string[], over: Partial<ScheduleInput> = {}): ScheduleInput => {
    const start = new Date(Date.now() + hoursAhead * HOUR);
    return { type: "IN_PERSON", start, end: new Date(start.getTime() + 45 * 60_000), roundName: "Trial shift", meetingLink: null, location: "Main outlet", instructions: "Ask about weekend availability.", participantIds, ...over };
  };
  // Moves an interview into the past (owner account: the app cannot do this).
  const startedAgo = (interviewId: string) =>
    raw.query(`UPDATE interviews SET scheduled_start = now() - interval '2 hours', scheduled_end = now() - interval '1 hour' WHERE id = $1`, [interviewId]);

  // A direct attempt as the app's account inside a rolled-back transaction: "ok" with the row count, or the error.
  async function asStaff(userId: string, orgId: string, sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number; error?: string }> {
    const token = await pgSessionToken(raw, userId, orgId);
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [token]);
      const r = await rt.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e) {
      return { rows: [], rowCount: 0, error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }

  async function scheduled(w: World, participants: string[] = [w.users.hr.id, w.users.sa.id]) {
    const app = await w.application();
    const { id } = await scheduleInterview(w.deps(), w.hr, app.id, slot(48, participants));
    return { app, id };
  }

  // ---------------------------------------------------------------------------
  it("schedules an interview: participants, round number, stage move, history and audit", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    const row = await owner.interview.findUniqueOrThrow({ where: { id }, include: { participants: true } });
    expect(row).toMatchObject({ roundNumber: 1, status: "SCHEDULED", createdById: w.users.hr.id, location: "Main outlet" });
    expect(row.participants.map((p) => p.interviewerId).sort()).toEqual([w.users.hr.id, w.users.sa.id].sort());
    const detail = await getApplication(db, w.hr, app.id);
    expect(detail.stage).toBe("INTERVIEW_SCHEDULED");
    expect(detail.history[0]).toMatchObject({ from: "SHORTLISTED", to: "INTERVIEW_SCHEDULED" });
    expect(w.entries.map((e) => e.action)).toEqual(["interview.scheduled", "application.stage_changed"]);
    // A second round gets the next number and does not move the stage again.
    const second = await scheduleInterview(w.deps(), w.sa, app.id, slot(72, [w.users.hr2.id]));
    expect((await owner.interview.findUniqueOrThrow({ where: { id: second.id } })).roundNumber).toBe(2);
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_SCHEDULED");
    expect((await listInterviewsFor(db, w.hr, { applicationId: app.id })).map((i) => i.roundNumber)).toEqual([2, 1]);
  });

  it("allows only active Super Admins and HR Managers as interviewers, in the service and in the database", async () => {
    const w = await world();
    const app = await w.application();
    await expect(scheduleInterview(w.deps(), w.hr, app.id, slot(48, [w.users.emp.id]))).rejects.toMatchObject({ fieldErrors: { participantIds: expect.any(String) } });
    const { id } = await scheduleInterview(w.deps(), w.hr, app.id, slot(48, [w.users.hr.id]));
    // Directly: an Employee cannot be added, nor someone from outside the organisation.
    const add = (userId: string) => asStaff(w.users.hr.id, w.org.id, `INSERT INTO interview_participants (id, organization_id, interview_id, interviewer_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [w.org.id, id, userId]);
    expect((await add(w.users.emp.id)).error).toMatch(/interviewer_not_eligible/);
    expect((await add(w.users.hr2.id)).error).toBeUndefined();
    // A suspended HR Manager is not eligible either.
    await owner.organizationMember.updateMany({ where: { organizationId: w.org.id, userId: w.users.hr2.id }, data: { status: "SUSPENDED" } });
    try {
      expect((await add(w.users.hr2.id)).error).toMatch(/interviewer_not_eligible/);
    } finally {
      await owner.organizationMember.updateMany({ where: { organizationId: w.org.id, userId: w.users.hr2.id }, data: { status: "ACTIVE" } });
    }
  });

  it("keeps Employees and other organisations out entirely", async () => {
    const w = await world();
    const other = await world();
    const { id, app } = await scheduled(w);
    await expect(listInterviews(db, w.emp, { view: "all" }, new Date())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getInterview(db, w.emp, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(scheduleInterview(w.deps(), w.emp, app.id, slot(48, [w.users.hr.id]))).rejects.toBeInstanceOf(ForbiddenError);
    // Another organisation's Super Admin: the interview and the application simply do not exist for them.
    await expect(getInterview(db, other.sa, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(scheduleInterview(other.deps(), other.sa, app.id, slot(48, [other.users.sa.id]))).rejects.toMatchObject({ code: "not_found" });
    expect((await listInterviews(db, other.sa, { view: "all" }, new Date())).total).toBe(0);
    // Directly in the database: nothing visible to the Employee or to the other organisation.
    for (const [who, org] of [[w.users.emp.id, w.org.id], [other.users.sa.id, other.org.id]] as const) {
      for (const t of ["interviews", "interview_participants", "interview_feedback", "hiring_decisions"]) {
        const r = await asStaff(who, org, `SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [w.org.id]);
        expect(r.rows[0]?.n, t).toBe(0);
      }
      expect((await asStaff(who, org, `UPDATE interviews SET round_name = 'x' WHERE id = $1`, [id])).rowCount).toBe(0);
    }
  });

  it("lets the database refuse a past time, a forged scheduler, a closed application, and deleting", async () => {
    const w = await world();
    const app = await w.application();
    const insert = (start: string, createdBy: string) =>
      asStaff(w.users.hr.id, w.org.id, `INSERT INTO interviews (id, organization_id, application_id, round_number, type, status, scheduled_start, scheduled_end, location, created_by_id, updated_at)
        VALUES (gen_random_uuid(), $1, $2, 1, 'IN_PERSON', 'SCHEDULED', ${start}, ${start} + interval '30 minutes', 'Outlet', $3, now())`, [w.org.id, app.id, createdBy]);
    expect((await insert("now() - interval '1 hour'", w.users.hr.id)).error).toMatch(/interview_in_past/);
    expect((await insert("now() + interval '1 day'", w.users.sa.id)).error).toMatch(/not allowed/);
    expect((await insert("now() + interval '1 day'", w.users.hr.id)).error).toBeUndefined();
    await moveApplicationStage(w.deps(), w.hr, app.id, "REJECTED", "Not available on weekends.");
    expect((await insert("now() + interval '1 day'", w.users.hr.id)).error).toMatch(/application_not_open/);
    await expect(scheduleInterview(w.deps(), w.hr, app.id, slot(48, [w.users.hr.id]))).rejects.toMatchObject({ code: "invalid" });
    // Interviews are cancelled, never deleted, by the app.
    const { id } = await scheduled(w);
    expect((await asStaff(w.users.sa.id, w.org.id, `DELETE FROM interviews WHERE id = $1`, [id])).error).toMatch(/permission denied/);
    expect((await asStaff(w.users.sa.id, w.org.id, `DELETE FROM interview_feedback`)).error).toMatch(/permission denied/);
    expect((await asStaff(w.users.sa.id, w.org.id, `DELETE FROM hiring_decisions`)).error).toMatch(/permission denied/);
  });

  it("reschedules and edits a scheduled interview, and keeps finished ones final", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id]);
    await updateInterview(w.deps(), w.hr, id, slot(96, [w.users.hr.id, w.users.hr2.id], { type: "ONLINE", location: null, meetingLink: "https://meet.example.com/abc" }));
    const row = await owner.interview.findUniqueOrThrow({ where: { id }, include: { participants: true } });
    expect(row).toMatchObject({ type: "ONLINE", meetingLink: "https://meet.example.com/abc", location: null });
    expect(row.participants).toHaveLength(2);
    expect(w.entries.at(-1)).toMatchObject({ action: "interview.rescheduled", metadata: { interviewersAdded: 1, interviewersRemoved: 0 } });
    await expect(updateInterview(w.deps(), w.hr, id, slot(-1, [w.users.hr.id]))).rejects.toMatchObject({ fieldErrors: { start: expect.any(String) } });
    await expect(recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED")).rejects.toMatchObject({ code: "invalid" }); // not started yet
    await startedAgo(id);
    await recordInterviewOutcome(w.deps(), w.hr, id, "NO_SHOW");
    await expect(updateInterview(w.deps(), w.hr, id, slot(48, [w.users.hr.id]))).rejects.toMatchObject({ code: "conflict" });
    await expect(cancelInterview(w.deps(), w.hr, id, "Changed our mind")).rejects.toMatchObject({ code: "conflict" });
    // Directly: a finished interview cannot be changed at all.
    expect((await asStaff(w.users.hr.id, w.org.id, `UPDATE interviews SET status = 'SCHEDULED' WHERE id = $1`, [id])).error).toMatch(/interview_closed/);
  });

  it("cancels with a reason, and the cancelled round number can be used again", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    await cancelInterview(w.deps(), w.sa, id, "Candidate asked to move it");
    expect(await owner.interview.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "CANCELLED", cancelReason: "Candidate asked to move it" });
    expect(JSON.stringify(w.entries.at(-1))).not.toContain("Candidate asked");
    const again = await scheduleInterview(w.deps(), w.hr, app.id, slot(50, [w.users.hr.id]));
    expect((await owner.interview.findUniqueOrThrow({ where: { id: again.id } })).roundNumber).toBe(1);
    // Directly: cancelling without a reason breaks the database's rule.
    expect((await asStaff(w.users.hr.id, w.org.id, `UPDATE interviews SET status = 'CANCELLED' WHERE id = $1`, [again.id])).error).toMatch(/interviews_cancel_reason/);
  });

  it("keeps feedback independent: drafts are private, colleagues' feedback appears only after submitting your own", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id, w.users.sa.id]);
    await expect(saveFeedback(w.deps(), w.hr, id, feedback(), "draft")).rejects.toMatchObject({ code: "invalid" }); // not started yet
    await startedAgo(id);
    // A non-participant cannot give feedback.
    await expect(saveFeedback(w.deps(), w.hr2, id, feedback(), "draft")).rejects.toMatchObject({ code: "invalid" });

    await saveFeedback(w.deps(), w.hr, id, feedback({ strengths: "Draft thoughts" }), "draft");
    // Nobody else sees a draft, not even a Super Admin.
    expect((await getInterview(db, w.sa, id)).otherFeedback).toEqual([]);
    expect((await getInterview(db, w.hr2, id)).otherFeedback).toEqual([]);
    expect((await asStaff(w.users.sa.id, w.org.id, `SELECT count(*)::int AS n FROM interview_feedback`)).rows[0]?.n).toBe(0);
    expect((await getInterview(db, w.hr, id)).myFeedbackRow).toMatchObject({ strengths: "Draft thoughts", submittedAt: null });

    await saveFeedback(w.deps(), w.hr, id, feedback(), "submit");
    // The audit record says only that feedback was submitted: no scores (Super Admins can read the audit log).
    expect(w.entries.at(-1)).toMatchObject({ action: "feedback.submitted", metadata: {} });
    expect(JSON.stringify(w.entries)).not.toContain("Calm under pressure");
    // The other interviewer (who has not submitted) still cannot see it; a non-participant HR Manager can.
    const saView = await getInterview(db, w.sa, id);
    expect(saView.otherFeedback).toEqual([]);
    expect(saView.othersHiddenUntilISubmit).toBe(true);
    expect((await getInterview(db, w.hr2, id)).otherFeedback.map((f) => f.interviewerName)).toEqual(["Harish"]);
    // Once the Super Admin submits too, each sees the other's.
    await saveFeedback(w.deps(), w.sa, id, feedback({ recommendation: "STRONGLY_RECOMMEND", ratings: { overallRating: 5 } }), "submit");
    expect((await getInterview(db, w.sa, id)).otherFeedback.map((f) => f.interviewerName)).toEqual(["Harish"]);
    expect((await getInterview(db, w.hr, id)).otherFeedback.map((f) => f.interviewerName)).toEqual(["Sana"]);
  });

  it("locks submitted feedback, and nobody can write or change someone else's", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id, w.users.sa.id]);
    await startedAgo(id);
    await saveFeedback(w.deps(), w.hr, id, feedback(), "submit");
    await expect(saveFeedback(w.deps(), w.hr, id, feedback({ strengths: "changed" }), "submit")).rejects.toMatchObject({ code: "conflict" });
    // Directly: the author cannot change it (the row is no longer editable), and the Super Admin cannot either.
    for (const who of [w.users.hr.id, w.users.sa.id]) {
      expect((await asStaff(who, w.org.id, `UPDATE interview_feedback SET strengths = 'tampered' WHERE organization_id = $1`, [w.org.id])).rowCount).toBe(0);
    }
    // Writing feedback under someone else's name, or for someone else's place on the interview, is refused.
    const saParticipant = (await owner.interviewParticipant.findFirstOrThrow({ where: { interviewId: id, interviewerId: w.users.sa.id } })).id;
    const forged = await asStaff(w.users.hr.id, w.org.id, `INSERT INTO interview_feedback (id, organization_id, participant_id, interviewer_id, overall_rating, recommendation, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 1, 'REJECT', now())`, [w.org.id, saParticipant, w.users.sa.id]);
    expect(forged.error).toMatch(/row-level security|not allowed/); // the trigger answers first; the policy would refuse it too
    const wrongSeat = await asStaff(w.users.hr.id, w.org.id, `INSERT INTO interview_feedback (id, organization_id, participant_id, interviewer_id, overall_rating, recommendation, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 1, 'REJECT', now())`, [w.org.id, saParticipant, w.users.hr.id]);
    expect(wrongSeat.error).toMatch(/not allowed/);
    // Nobody can be taken off a started interview (so feedback can never be removed with its interviewer).
    await expect(updateInterview(w.deps(), w.sa, id, slot(48, [w.users.sa.id]))).rejects.toMatchObject({ code: "invalid" });
    const hrParticipant = (await owner.interviewParticipant.findFirstOrThrow({ where: { interviewId: id, interviewerId: w.users.hr.id } })).id;
    expect((await asStaff(w.users.sa.id, w.org.id, `DELETE FROM interview_participants WHERE id = $1`, [hrParticipant])).error).toMatch(/interview_started/);
  });

  it("completes the last interview, then records a decision that moves the application", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    await expect(recordDecision(w.deps(), w.hr, app.id, { outcome: "SELECTED", rationale: "Strong" })).rejects.toMatchObject({ code: "invalid" });
    await startedAgo(id);
    await recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED");
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_COMPLETED");

    await recordDecision(w.deps(), w.hr, app.id, { outcome: "ON_HOLD", rationale: "Waiting for the second outlet to confirm headcount." });
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_COMPLETED");
    await recordDecision(w.deps(), w.sa, app.id, { outcome: "SELECTED", rationale: "Best trial shift this month." });
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("SELECTED");
    expect(await getDecision(db, w.hr, app.id)).toMatchObject({ outcome: "SELECTED", decidedByName: "Sana" });
    expect(w.entries.filter((e) => e.action.startsWith("decision.")).map((e) => [e.action, e.metadata?.previous ?? null])).toEqual([
      ["decision.recorded", null],
      ["decision.changed", "ON_HOLD"],
    ]);
    // Changing it to Rejected rejects the application, with the reason; reopening is needed to go back.
    await recordDecision(w.deps(), w.hr, app.id, { outcome: "REJECTED", rationale: "Moved to another city." });
    expect(await getApplication(db, w.hr, app.id)).toMatchObject({ stage: "REJECTED", rejectionReason: "Moved to another city." });
    await expect(recordDecision(w.deps(), w.hr, app.id, { outcome: "SELECTED", rationale: "Back again" })).rejects.toMatchObject({ code: "invalid" });
    // Employees cannot decide; the database refuses a decision recorded under someone else's name.
    await expect(recordDecision(w.deps(), w.emp, app.id, { outcome: "SELECTED", rationale: "x x x" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await asStaff(w.users.hr.id, w.org.id, `UPDATE hiring_decisions SET decided_by_id = $1 WHERE application_id = $2`, [w.users.sa.id, app.id])).error).toMatch(/not allowed/);
  });

  it("does not move to Interview completed while another round is still scheduled", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    await scheduleInterview(w.deps(), w.hr, app.id, slot(72, [w.users.hr.id]));
    await startedAgo(id);
    await recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED");
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_SCHEDULED");
  });

  it("removing a candidate also clears what was written about them in interviews, feedback and decisions", async () => {
    const w = await world();
    const { app, id } = await scheduled(w, [w.users.hr.id]);
    await startedAgo(id);
    await saveFeedback(w.deps(), w.hr, id, feedback({ notes: "Mentioned a health condition." }), "submit");
    await recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED");
    await recordDecision(w.deps(), w.hr, app.id, { outcome: "REJECTED", rationale: "Could not do early shifts for family reasons." });
    const oc = (await owner.application.findUniqueOrThrow({ where: { id: app.id } })).organizationCandidateId;
    await removeCandidate(w.deps(), w.hr, oc);
    expect(await owner.interview.findUniqueOrThrow({ where: { id } })).toMatchObject({ instructions: null, roundName: null, status: "COMPLETED", roundNumber: 1 });
    const f = await owner.interviewFeedback.findFirstOrThrow({ where: { organizationId: w.org.id } });
    expect(f).toMatchObject({ strengths: null, weaknesses: null, notes: null, overallRating: 4, recommendation: "RECOMMEND" });
    expect(await owner.hiringDecision.findFirstOrThrow({ where: { applicationId: app.id } })).toMatchObject({ outcome: "REJECTED", rationale: null });
    // And the removed person's interviews disappear from the screens.
    expect((await listInterviews(db, w.hr, { view: "all" }, new Date())).total).toBe(0);
    await expect(getInterview(db, w.hr, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists what is waiting for my feedback", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id]);
    expect((await listInterviews(db, w.hr, { view: "feedback" }, new Date())).total).toBe(0);
    await startedAgo(id);
    const waiting = await listInterviews(db, w.hr, { view: "feedback" }, new Date());
    expect(waiting.items.map((i) => [i.id, i.myFeedback])).toEqual([[id, "none"]]);
    expect((await listInterviews(db, w.sa, { view: "feedback" }, new Date())).total).toBe(0); // not an interviewer
    await saveFeedback(w.deps(), w.hr, id, feedback(), "submit");
    expect((await listInterviews(db, w.hr, { view: "feedback" }, new Date())).total).toBe(0);
  });
  // ---------------------------------------------------------------------------
  // Regression tests for the independent review of 18 Nov 2026 (migration 20261118010000_interviews_review_fixes)
  // ---------------------------------------------------------------------------
  it("fixes who interviews, and when, once the interview has started (no stepping off to read feedback and back on)", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id, w.users.sa.id]);
    await startedAgo(id);
    await saveFeedback(w.deps(), w.sa, id, feedback(), "submit");
    // The HR Manager, who has not written anything, cannot step off the interview ...
    await expect(updateInterview(w.deps(), w.hr, id, slot(48, [w.users.sa.id]))).rejects.toMatchObject({ code: "invalid" });
    const mine = (await owner.interviewParticipant.findFirstOrThrow({ where: { interviewId: id, interviewerId: w.users.hr.id } })).id;
    expect((await asStaff(w.users.hr.id, w.org.id, `DELETE FROM interview_participants WHERE id = $1`, [mine])).error).toMatch(/interview_started/);
    // ... so they still cannot read the Super Admin's feedback before writing their own.
    expect((await getInterview(db, w.hr, id)).otherFeedback).toEqual([]);
    // Someone who was not an interviewer (and can read submitted feedback) cannot join after reading it.
    expect((await getInterview(db, w.hr2, id)).otherFeedback).toHaveLength(1);
    const join = await asStaff(w.users.hr2.id, w.org.id, `INSERT INTO interview_participants (id, organization_id, interview_id, interviewer_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [w.org.id, id, w.users.hr2.id]);
    expect(join.error).toMatch(/interview_started/);
    // And a started interview cannot be moved to another time, in the service or directly.
    await expect(updateInterview(w.deps(), w.hr, id, slot(48, [w.users.hr.id, w.users.sa.id]))).rejects.toMatchObject({ code: "invalid" });
    const move = await asStaff(w.users.hr.id, w.org.id, `UPDATE interviews SET scheduled_start = now() + interval '7 days', scheduled_end = now() + interval '7 days 1 hour' WHERE id = $1`, [id]);
    expect(move.error).toMatch(/interview_started/);
  });

  it("removal cancels scheduled interviews, clears place and link, and the database refuses new text about a removed candidate", async () => {
    const w = await world();
    const app = await w.application();
    const online = await scheduleInterview(w.deps(), w.hr, app.id, slot(48, [w.users.hr.id], { type: "ONLINE", location: null, meetingLink: "https://meet.example.com/kavya-rao" }));
    const done = await scheduleInterview(w.deps(), w.hr, app.id, slot(50, [w.users.hr.id], { location: "Her home, 12 Park Road" }));
    await startedAgo(done.id);
    await recordInterviewOutcome(w.deps(), w.hr, done.id, "COMPLETED");
    await moveApplicationStage(w.deps(), w.hr, app.id, "REJECTED", "Not available on weekends.");
    const oc = (await owner.application.findUniqueOrThrow({ where: { id: app.id } })).organizationCandidateId;
    await removeCandidate(w.deps(), w.hr, oc);
    expect(await owner.interview.findUniqueOrThrow({ where: { id: online.id } })).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Removed with the candidate's data",
      meetingLink: "https://removed.invalid",
    });
    expect(await owner.interview.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: "COMPLETED", cancelReason: null, location: "Removed" });
    // Directly: no new feedback, decision or interview text about the removed person.
    const seat = (await owner.interviewParticipant.findFirstOrThrow({ where: { interviewId: done.id } })).id;
    const fb = await asStaff(w.users.hr.id, w.org.id, `INSERT INTO interview_feedback (id, organization_id, participant_id, interviewer_id, notes, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'more about her', now())`, [w.org.id, seat, w.users.hr.id]);
    expect(fb.error).toMatch(/candidate_removed/);
    const dec = await asStaff(w.users.hr.id, w.org.id, `INSERT INTO hiring_decisions (id, organization_id, application_id, outcome, rationale, decided_by_id) VALUES (gen_random_uuid(), $1, $2, 'REJECTED', 'more about her', $3)`, [w.org.id, app.id, w.users.hr.id]);
    expect(dec.error).toMatch(/candidate_removed/);
    expect((await asStaff(w.users.hr.id, w.org.id, `UPDATE interviews SET instructions = 'more about her' WHERE id = $1`, [online.id])).error).toMatch(/interview_closed/);
  });

  it("does not let the app's account delete an application (which would wipe its interviews, feedback and decision)", async () => {
    const w = await world();
    const { app } = await scheduled(w);
    expect((await asStaff(w.users.sa.id, w.org.id, `DELETE FROM applications WHERE id = $1`, [app.id])).error).toMatch(/permission denied/);
  });

  it("moves to Interview completed when the last open round ends as a no-show or is cancelled, and when two rounds end at once", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    const second = await scheduleInterview(w.deps(), w.hr, app.id, slot(72, [w.users.hr.id]));
    await startedAgo(id);
    await recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED");
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_SCHEDULED");
    await cancelInterview(w.deps(), w.hr, second.id, "Not needed after the first round");
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("INTERVIEW_COMPLETED");
    // Only no-shows: nothing was completed, so the stage stays.
    const w2 = await world();
    const only = await scheduled(w2);
    await startedAgo(only.id);
    await recordInterviewOutcome(w2.deps(), w2.hr, only.id, "NO_SHOW");
    expect((await getApplication(db, w2.hr, only.app.id)).stage).toBe("INTERVIEW_SCHEDULED");
    // Two rounds completed by two people at the same moment: the application row is locked, so it still moves.
    const w3 = await world();
    const a = await scheduled(w3);
    const b = await scheduleInterview(w3.deps(), w3.hr, a.app.id, slot(72, [w3.users.hr.id]));
    await startedAgo(a.id);
    await startedAgo(b.id);
    await Promise.all([recordInterviewOutcome(w3.deps(), w3.hr, a.id, "COMPLETED"), recordInterviewOutcome(w3.deps(), w3.sa, b.id, "COMPLETED")]);
    expect((await getApplication(db, w3.hr, a.app.id)).stage).toBe("INTERVIEW_COMPLETED");
  });

  it("refuses On hold for an application already Selected, keeping decision and stage together", async () => {
    const w = await world();
    const { app, id } = await scheduled(w);
    await startedAgo(id);
    await recordInterviewOutcome(w.deps(), w.hr, id, "COMPLETED");
    await recordDecision(w.deps(), w.hr, app.id, { outcome: "SELECTED", rationale: "Best trial shift." });
    await expect(recordDecision(w.deps(), w.hr, app.id, { outcome: "ON_HOLD", rationale: "Wait a bit." })).rejects.toMatchObject({ code: "invalid" });
    expect((await getApplication(db, w.hr, app.id)).stage).toBe("SELECTED");
    expect(await getDecision(db, w.hr, app.id)).toMatchObject({ outcome: "SELECTED" });
  });

  it("lets the interviewers of a no-show interview read colleagues' submitted feedback (nothing can be written any more)", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id, w.users.sa.id]);
    await startedAgo(id);
    await saveFeedback(w.deps(), w.sa, id, feedback(), "submit");
    expect((await getInterview(db, w.hr, id)).othersHiddenUntilISubmit).toBe(true);
    await recordInterviewOutcome(w.deps(), w.hr, id, "NO_SHOW");
    const view = await getInterview(db, w.hr, id);
    expect(view.othersHiddenUntilISubmit).toBe(false);
    expect(view.otherFeedback.map((f) => f.interviewerName)).toEqual(["Sana"]);
  });

  it("gives a clear answer when the same person saves first feedback twice at once, and survives odd page numbers", async () => {
    const w = await world();
    const { id } = await scheduled(w, [w.users.hr.id]);
    await startedAgo(id);
    const results = await Promise.allSettled([saveFeedback(w.deps(), w.hr, id, feedback(), "draft"), saveFeedback(w.deps(), w.hr, id, feedback(), "draft")]);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    expect(await owner.interviewFeedback.count({ where: { organizationId: w.org.id } })).toBe(1);
    expect((await listInterviews(db, w.hr, { view: "all", page: 1.5 }, new Date())).page).toBe(1);
  });
});
