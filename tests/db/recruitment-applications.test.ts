// Tests applications, candidates, documents and the public job pages against the DISPOSABLE test database only.
// The audit writer is replaced by a recorder (real audit rows can never be deleted) and files go to memory.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { createDb, type Db } from "@/lib/db";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { realRoleIds } from "./roles-helper";
import { type ApplicationInput, parseApplicationInput } from "@/lib/recruitment/application-input";
import {
  addApplicationNote,
  type AppDeps,
  applyPublicly,
  assignRecruiter,
  createApplicationManually,
  getApplication,
  listApplications,
  listAssignableRecruiters,
  listPipeline,
  moveApplicationStage,
  type ResumeUpload,
} from "@/lib/recruitment/applications";
import { getCandidate, listCandidates, updateCandidateNotes } from "@/lib/recruitment/candidates";
import { readDocument } from "@/lib/recruitment/documents";
import { getPublicJob, listPublicJobs } from "@/lib/recruitment/public-jobs";
import type { FileStorage } from "@/lib/recruitment/storage";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const now = new Date("2026-11-15T06:00:00.000Z");
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
const EMAIL_DOMAIN = "apps-test.example.test";

// Exactly the permissions of the real roles (src/lib/auth/roles.ts).
const HR = [...ROLE_PERMISSIONS.HR_MANAGER];
const EMPLOYEE = [...ROLE_PERMISSIONS.EMPLOYEE];

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const resume = (): ResumeUpload => ({ bytes: PDF, kind: { extension: "pdf", mimeType: "application/pdf" }, safeName: "cv.pdf" });

function person(overrides: Record<string, string> = {}): ApplicationInput {
  const r = parseApplicationInput({
    fullName: "Asha Verma",
    email: `asha-${rnd()}@${EMAIL_DOMAIN}`,
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    city: "Indore",
    institution: "DAVV",
    degree: "BBA",
    graduationYear: "2025",
    skills: "Espresso, Billing",
    ...overrides,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe.skipIf(!enabled)("applications and candidates (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  let role: Record<RoleKey, string>;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 5 });
    role = await realRoleIds(owner);
  });
  afterAll(async () => {
    if (owner) {
      await owner.candidateDocument.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.application.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organizationCandidate.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.candidateProfile.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
      await owner.jobOpening.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds); // a public application is audited by the database itself
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  function memoryStorage() {
    const files = new Map<string, Uint8Array>();
    const storage: FileStorage = {
      put: async (k, b) => void files.set(k, b),
      get: async (k) => files.get(k) ?? null,
      remove: async (k) => void files.delete(k),
    };
    return { files, storage };
  }

  async function makeUser(name: string) {
    const u = await owner.user.create({ data: { email: `staff-${rnd()}@${EMAIL_DOMAIN}`, name } });
    userIds.push(u.id);
    return u;
  }
  const ctxFor = (user: { id: string; email: string; name: string }, org: { id: string; name: string; slug: string }, permissions: string[]): AuthContext => ({
    sessionId: "00000000-0000-0000-0000-000000000000",
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: false },
    organization: { id: org.id, name: org.name, slug: org.slug },
    memberId: null,
    expiresAt: now,
    absoluteExpiresAt: now,
    roleKeys: [],
    permissions: new Set(permissions),
  });

  // One organisation with an HR user, two HR Managers and an Employee (real members with real roles),
  // and a published public job.
  async function world() {
    const hr = await makeUser("Hema HR");
    const rec1 = await makeUser("Ravi Manager");
    const rec2 = await makeUser("Rita Manager");
    const emp = await makeUser("Eli Employee");
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: `Org ${rnd()}`, ownerUserId: hr.id, timezone: TZ } });
    orgIds.push(org.id);
    // Real, active members with real roles: the database checks real membership (row-level security).
    for (const [u, key] of [[hr, "SUPER_ADMIN"], [rec1, "HR_MANAGER"], [rec2, "HR_MANAGER"], [emp, "EMPLOYEE"]] as const) {
      await owner.organizationMember.create({ data: { organizationId: org.id, userId: u.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role[key] }] } } });
    }
    const makeJob = (data: { title: string; status?: "DRAFT" | "PUBLISHED" | "CLOSED" | "ARCHIVED"; visibility?: "PUBLIC" | "INTERNAL_ONLY"; applicationDeadline?: Date }) =>
      owner.jobOpening.create({
        data: {
          organizationId: org.id,
          slug: `job-${rnd()}`,
          description: "A job used by automated tests.",
          employmentType: "FULL_TIME",
          workMode: "ON_SITE",
          createdById: hr.id,
          status: "PUBLISHED",
          publishedAt: now,
          ...data,
        },
      });
    const job = await makeJob({ title: "Barista" });
    const entries: AuditEntry[] = [];
    const mem = memoryStorage();
    const deps: AppDeps = { db, now, writeAudit: async (_db, e) => void entries.push(e), client: { ipAddress: null, userAgent: "vitest" }, storage: mem.storage };
    return {
      org, job, makeJob, deps, entries, files: mem.files,
      // Each with a real, live session: the database works out who is asking from it.
      hr: await giveSession(owner, ctxFor(hr, org, HR)),
      rec1: await giveSession(owner, ctxFor(rec1, org, HR)),
      rec2: await giveSession(owner, ctxFor(rec2, org, HR)),
      employee: await giveSession(owner, ctxFor(emp, org, EMPLOYEE)),
      rec1User: rec1, rec2User: rec2, empUser: emp,
      target: (j: { slug: string }) => ({ organizationSlug: org.slug, jobSlug: j.slug }),
    };
  }

  it("saves a public application with its resume, history and a reference number", async () => {
    const w = await world();
    const input = person();
    const created = await applyPublicly(w.deps, w.target(w.job), input, resume());
    expect(created.referenceNumber).toMatch(/^APP-2026-[2-9A-Z]{6}$/);
    expect(created.candidateWasKnown).toBe(false);

    const app = await getApplication(db, w.hr, created.id);
    expect(app).toMatchObject({ stage: "APPLIED", enteredByStaff: false, recruiter: null, candidate: { name: "Asha Verma", email: input.email }, job: { id: w.job.id } });
    expect(app.snapshot).toMatchObject({ city: "Indore", education: { institution: "DAVV", graduationYear: 2025 }, skills: ["Espresso", "Billing"] });
    expect(app.history).toHaveLength(1);
    expect(app.history[0]).toMatchObject({ from: null, to: "APPLIED", byName: "The candidate" });
    expect(app.documents).toHaveLength(1);
    expect(app.documents[0]).toMatchObject({ name: "cv.pdf", kind: "RESUME", sizeBytes: PDF.length });
    expect(w.files.size).toBe(1);
    expect([...w.files.keys()][0]).toMatch(/^resumes\/2026\/[0-9a-f-]{36}$/); // nothing the candidate typed is in the path
    // The DATABASE writes the audit record of a public application itself (the app cannot skip or forge it).
    const submitted = await owner.auditLog.findMany({ where: { organizationId: w.org.id, action: "application.submitted" } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ actorUserId: null, entityType: "application", entityId: created.id, metadata: { reference: created.referenceNumber, knownCandidate: false, hasResume: true } });
    expect(w.entries).toEqual([]); // nothing went through the application's own audit writer

    // The central profile got the education, experience and skills too.
    const profile = await owner.candidateProfile.findUniqueOrThrow({ where: { email: input.email }, include: { educations: true, skills: true } });
    expect(profile.educations).toHaveLength(1);
    expect(profile.skills.map((s) => s.name).sort()).toEqual(["billing", "espresso"]);
  });

  it("keeps ONE candidate profile when the same person applies to another job", async () => {
    const w = await world();
    const job2 = await w.makeJob({ title: "Cashier" });
    const first = person();
    const a = await applyPublicly(w.deps, w.target(w.job), first, resume());
    // Same email typed with capitals and a different name: still the same person's profile, not overwritten.
    const second = person({ email: first.email.toUpperCase(), fullName: "Somebody Else", city: "Bhopal" });
    const b = await applyPublicly(w.deps, w.target(job2), second, resume());
    expect(b.candidateWasKnown).toBe(true);

    expect(await owner.candidateProfile.count({ where: { email: first.email } })).toBe(1);
    const appA = await getApplication(db, w.hr, a.id);
    const appB = await getApplication(db, w.hr, b.id);
    expect(appB.candidate.id).toBe(appA.candidate.id);
    expect(appB.candidate.name).toBe("Asha Verma"); // the profile was not rewritten by an unverified form
    expect(appB.snapshot).toMatchObject({ fullName: "Somebody Else", city: "Bhopal" }); // but what was typed is kept with the application

    const candidate = await getCandidate(db, w.hr, appA.candidate.id);
    expect(candidate.applications.map((x) => x.job.title).sort()).toEqual(["Barista", "Cashier"]);
    expect(candidate.documents).toHaveLength(2);
    expect((await listCandidates(db, w.hr, {})).total).toBe(1);
  });

  it("refuses a second application to the same job and removes the orphaned file", async () => {
    const w = await world();
    const input = person();
    await applyPublicly(w.deps, w.target(w.job), input, resume());
    await expect(applyPublicly(w.deps, w.target(w.job), input, resume())).rejects.toMatchObject({ code: "duplicate" });
    expect(w.files.size).toBe(1);
    expect(await owner.application.count({ where: { jobId: w.job.id } })).toBe(1);
  });

  it("handles two identical submissions arriving at the same moment", async () => {
    const w = await world();
    const input = person();
    const results = await Promise.allSettled([applyPublicly(w.deps, w.target(w.job), input, resume()), applyPublicly(w.deps, w.target(w.job), input, resume())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "duplicate" } });
    expect(await owner.candidateProfile.count({ where: { email: input.email } })).toBe(1);
    expect(w.files.size).toBe(1);
  });

  it("accepts public applications only for published, public, unexpired jobs", async () => {
    const w = await world();
    const closedJob = await w.makeJob({ title: "Closed", status: "CLOSED" });
    const archived = await w.makeJob({ title: "Archived", status: "ARCHIVED" });
    const draft = await w.makeJob({ title: "Draft", status: "DRAFT" });
    const internal = await w.makeJob({ title: "Internal", visibility: "INTERNAL_ONLY" });
    const expired = await w.makeJob({ title: "Expired", applicationDeadline: new Date(now.getTime() - 1000) });
    // Closed and archived jobs do not exist as far as the public is concerned (the public database context
    // can only see published jobs); a published job past its deadline is reported as closed.
    await expect(applyPublicly(w.deps, w.target(closedJob), person(), resume())).rejects.toMatchObject({ code: "not_found" });
    await expect(applyPublicly(w.deps, w.target(archived), person(), resume())).rejects.toMatchObject({ code: "not_found" });
    await expect(applyPublicly(w.deps, w.target(expired), person(), resume())).rejects.toMatchObject({ code: "closed" });
    await expect(applyPublicly(w.deps, w.target(draft), person(), resume())).rejects.toMatchObject({ code: "not_found" });
    await expect(applyPublicly(w.deps, w.target(internal), person(), resume())).rejects.toMatchObject({ code: "not_found" });
    await expect(applyPublicly(w.deps, { organizationSlug: "no-such-org", jobSlug: w.job.slug }, person(), resume())).rejects.toMatchObject({ code: "not_found" });
    expect(w.files.size).toBe(0);
    expect(await owner.application.count({ where: { organizationId: w.org.id } })).toBe(0);

    // The public pages agree: only the open public job is listed or shown.
    expect((await listPublicJobs(db, w.org.slug, now)).map((j) => j.title)).toEqual(["Barista"]);
    for (const j of [closedJob, archived, draft, internal]) expect(await getPublicJob(db, w.org.slug, j.slug, now)).toBeNull();
    expect(await getPublicJob(db, w.org.slug, expired.slug, now)).toMatchObject({ accepting: false });
    const shown = await getPublicJob(db, w.org.slug, w.job.slug, now);
    expect(shown).toMatchObject({ title: "Barista", accepting: true });
    expect(Object.keys(shown!)).not.toContain("createdById");
  });

  it("lets HR add an application by hand, with or without a resume", async () => {
    const w = await world();
    const created = await createApplicationManually(w.deps, w.hr, w.job.id, person({ source: "Walk-in" }), null);
    const app = await getApplication(db, w.hr, created.id);
    expect(app).toMatchObject({ enteredByStaff: true, enteredByName: "Hema HR", source: "Walk-in", documents: [] });
    expect(app.history[0]).toMatchObject({ byName: "Hema HR" });
    expect(w.entries.at(-1)).toMatchObject({ action: "application.created_by_staff", actorUserId: w.hr.user.id });

    await expect(createApplicationManually(w.deps, w.employee, w.job.id, person(), null)).rejects.toBeInstanceOf(ForbiddenError);
    const closedJob = await w.makeJob({ title: "Closed", status: "CLOSED" });
    await expect(createApplicationManually(w.deps, w.hr, closedJob.id, person(), null)).rejects.toMatchObject({ code: "closed" });
    const other = await world();
    await expect(createApplicationManually(w.deps, w.hr, other.job.id, person(), null)).rejects.toMatchObject({ code: "invalid" });
  });

  it("runs the full workflow: assign, note, review, shortlist, with complete history", async () => {
    const w = await world();
    const { id } = await applyPublicly(w.deps, w.target(w.job), person(), resume());

    // HR Managers see every application of their organisation, before and after it is assigned.
    expect((await getApplication(db, w.rec1, id)).recruiter).toBeNull();
    expect((await listApplications(db, w.rec1, {}, TZ)).total).toBe(1);

    expect((await listAssignableRecruiters(db, w.hr)).map((r) => r.name)).toEqual(["Hema HR", "Ravi Manager", "Rita Manager"]);
    await assignRecruiter(w.deps, w.hr, id, w.rec1User.id);

    const seen = await getApplication(db, w.rec1, id);
    expect(seen.recruiter).toMatchObject({ name: "Ravi Manager" });
    expect(seen.assignedAt).toEqual(now);

    const t1 = { ...w.deps, now: new Date(now.getTime() + 60_000) };
    await addApplicationNote(t1, w.rec1, id, "  Spoke on the phone, sounds keen.  ");
    const t2 = { ...w.deps, now: new Date(now.getTime() + 120_000) };
    await moveApplicationStage(t2, w.rec1, id, "UNDER_REVIEW");
    const t3 = { ...w.deps, now: new Date(now.getTime() + 180_000) };
    await moveApplicationStage(t3, w.hr, id, "SHORTLISTED");

    const app = await getApplication(db, w.hr, id);
    expect(app.stage).toBe("SHORTLISTED");
    expect(app.stageChangedAt).toEqual(t3.now);
    expect(app.notes).toEqual([expect.objectContaining({ body: "Spoke on the phone, sounds keen.", authorName: "Ravi Manager", createdAt: t1.now })]);
    expect(app.history.map((h) => [h.from, h.to, h.byName])).toEqual([
      ["UNDER_REVIEW", "SHORTLISTED", "Hema HR"],
      ["APPLIED", "UNDER_REVIEW", "Ravi Manager"],
      [null, "APPLIED", "The candidate"],
    ]);
    expect(app.assignments).toEqual([expect.objectContaining({ recruiterName: "Ravi Manager", byName: "Hema HR", unassigned: false })]);
    expect(w.entries.map((e) => e.action)).toEqual(["application.assigned", "application.note_added", "application.stage_changed", "application.stage_changed"]); // (the submission itself is audited by the database)
    expect(JSON.stringify(w.entries)).not.toContain("sounds keen"); // note text never reaches the audit log
  });

  it("validates stage moves and records rejection reasons", async () => {
    const w = await world();
    const { id } = await applyPublicly(w.deps, w.target(w.job), person(), resume());
    await expect(moveApplicationStage(w.deps, w.hr, id, "REJECTED")).rejects.toMatchObject({ code: "invalid" });
    await expect(moveApplicationStage(w.deps, w.hr, id, "APPLIED")).rejects.toMatchObject({ code: "conflict" });
    await expect(moveApplicationStage(w.deps, w.hr, id, "OFFER_ISSUED" as never)).rejects.toMatchObject({ code: "invalid" });
    await moveApplicationStage(w.deps, w.hr, id, "REJECTED", "Not enough experience");
    let app = await getApplication(db, w.hr, id);
    expect(app).toMatchObject({ stage: "REJECTED", rejectionReason: "Not enough experience" });
    await expect(moveApplicationStage(w.deps, w.hr, id, "WITHDRAWN")).rejects.toMatchObject({ code: "invalid" });
    await moveApplicationStage(w.deps, w.hr, id, "UNDER_REVIEW", "Rejected by mistake");
    app = await getApplication(db, w.hr, id);
    expect(app).toMatchObject({ stage: "UNDER_REVIEW", rejectionReason: null });
    expect(app.history).toHaveLength(3);
    expect(app.history.map((h) => h.reason)).toContain("Not enough experience"); // history keeps it even after reopening

    // The database itself refuses to rewrite history.
    const row = await owner.applicationStatusHistory.findFirstOrThrow({ where: { applicationId: id } });
    await expect(db.applicationStatusHistory.update({ where: { id: row.id }, data: { reason: "rewritten" } })).rejects.toThrow();
  });

  it("stops two people moving the same application at once", async () => {
    const w = await world();
    const { id } = await applyPublicly(w.deps, w.target(w.job), person(), resume());
    // Both try the same move. Whether the database runs them together or one after the other,
    // exactly one may succeed; the other is told the application has already moved.
    const results = await Promise.allSettled([moveApplicationStage(w.deps, w.hr, id, "UNDER_REVIEW"), moveApplicationStage(w.deps, w.rec1, id, "UNDER_REVIEW")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect((await getApplication(db, w.hr, id)).history).toHaveLength(2);
  });

  it("keeps Employees out of every recruitment record and document", async () => {
    const w = await world();
    const a = await applyPublicly(w.deps, w.target(w.job), person({ fullName: "Hidden Candidate" }), resume());
    const app = await getApplication(db, w.hr, a.id);
    const e = w.employee;
    const refused = [
      () => listApplications(db, e, {}, TZ),
      () => listPipeline(db, e, {}, TZ),
      () => listCandidates(db, e, {}),
      () => getApplication(db, e, a.id),
      () => getCandidate(db, e, app.candidate.id),
      () => listAssignableRecruiters(db, e),
      () => moveApplicationStage(w.deps, e, a.id, "UNDER_REVIEW"),
      () => addApplicationNote(w.deps, e, a.id, "peeking"),
      () => assignRecruiter(w.deps, e, a.id, w.rec1User.id),
      () => createApplicationManually(w.deps, e, w.job.id, person(), null),
      () => updateCandidateNotes(w.deps, e, app.candidate.id, "x"),
      () => readDocument(w.deps, e, app.documents[0]!.id),
    ];
    for (const attempt of refused) await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getApplication(db, w.hr, a.id)).stage).toBe("APPLIED"); // nothing changed
    expect(w.entries).toEqual([]); // nothing was recorded (the submission itself is audited by the database)

    // Seeing an application is not enough to read the resume: that needs its own permission.
    const noDocs = await giveSession(owner, { ...w.hr, permissions: new Set(HR.filter((p) => p !== "document:read")) });
    expect((await getApplication(db, noDocs, a.id)).documents).toEqual([]);
    await expect(readDocument(w.deps, noDocs, app.documents[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    const file = await readDocument(w.deps, w.rec1, app.documents[0]!.id);
    expect(file.bytes).toEqual(PDF);
    expect(w.entries.at(-1)).toMatchObject({ action: "document.downloaded", actorUserId: w.rec1.user.id });
  });

  it("only an active HR Manager or Super Admin can be the responsible HR person", async () => {
    const w = await world();
    const a = await applyPublicly(w.deps, w.target(w.job), person(), resume());
    // The Employee is not offered, and cannot be chosen even by asking directly.
    expect((await listAssignableRecruiters(db, w.hr)).map((r) => r.name)).toEqual(["Hema HR", "Ravi Manager", "Rita Manager"]);
    await expect(assignRecruiter(w.deps, w.hr, a.id, w.empUser.id)).rejects.toMatchObject({ code: "invalid" });
    // A suspended HR Manager drops out of the list and cannot be chosen.
    await owner.organizationMember.updateMany({ where: { organizationId: w.org.id, userId: w.rec2User.id }, data: { status: "SUSPENDED" } });
    expect((await listAssignableRecruiters(db, w.hr)).map((r) => r.name)).toEqual(["Hema HR", "Ravi Manager"]);
    await expect(assignRecruiter(w.deps, w.hr, a.id, w.rec2User.id)).rejects.toMatchObject({ code: "invalid" });
    // Any HR Manager may change the responsible person; the history keeps every change.
    await assignRecruiter(w.deps, w.hr, a.id, w.rec1User.id);
    await assignRecruiter({ ...w.deps, now: new Date(now.getTime() + 60_000) }, w.rec1, a.id, null);
    const app = await getApplication(db, w.hr, a.id);
    expect(app.recruiter).toBeNull();
    expect(app.assignments.map((x) => [x.recruiterName, x.unassigned, x.byName])).toEqual([
      [null, true, "Ravi Manager"],
      ["Ravi Manager", false, "Hema HR"],
    ]);
  });

  it("keeps organisations completely apart", async () => {
    const a = await world();
    const b = await world();
    const input = person();
    const inA = await applyPublicly(a.deps, a.target(a.job), input, resume());
    const inB = await applyPublicly(b.deps, b.target(b.job), person({ email: input.email, city: "Pune" }), resume());
    const appA = await getApplication(db, a.hr, inA.id);

    await expect(getApplication(db, b.hr, inA.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getCandidate(db, b.hr, appA.candidate.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(readDocument(a.deps, b.hr, appA.documents[0]!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(moveApplicationStage(b.deps, b.hr, inA.id, "UNDER_REVIEW")).rejects.toMatchObject({ code: "not_found" });
    await expect(assignRecruiter(a.deps, a.hr, inA.id, b.rec1User.id)).rejects.toMatchObject({ code: "invalid" }); // another company's recruiter

    // The same person applied to both companies: one shared profile, but each company sees only its own application.
    const appB = await getApplication(db, b.hr, inB.id);
    const candidateInB = await getCandidate(db, b.hr, appB.candidate.id);
    expect(candidateInB.applications).toHaveLength(1);
    expect(candidateInB.latest).toMatchObject({ city: "Pune" });
    expect(candidateInB.documents).toHaveLength(1);
    expect((await listApplications(db, b.hr, {}, TZ)).total).toBe(1);
  });

  it("searches, filters and sorts the applications list", async () => {
    const w = await world();
    const job2 = await w.makeJob({ title: "Cashier" });
    const at = (minutes: number) => ({ ...w.deps, now: new Date(now.getTime() + minutes * 60_000) });
    const a = await applyPublicly(at(0), w.target(w.job), person({ fullName: "Zoya Khan" }), resume());
    const b = await applyPublicly(at(1), w.target(w.job), person({ fullName: "Aman Gupta" }), resume());
    const c = await applyPublicly(at(60 * 30), w.target(job2), person({ fullName: "Meera Nair" }), resume()); // the next day in India
    await assignRecruiter(w.deps, w.hr, a.id, w.rec1User.id);
    await moveApplicationStage(at(5), w.hr, b.id, "SHORTLISTED");

    const names = async (f: Parameters<typeof listApplications>[2]) => (await listApplications(db, w.hr, f, TZ)).items.map((x) => x.candidate.name);
    expect(await names({})).toEqual(["Meera Nair", "Aman Gupta", "Zoya Khan"]);
    expect(await names({ sort: "oldest" })).toEqual(["Zoya Khan", "Aman Gupta", "Meera Nair"]);
    expect(await names({ sort: "candidate" })).toEqual(["Aman Gupta", "Meera Nair", "Zoya Khan"]);
    expect(await names({ search: "zoya" })).toEqual(["Zoya Khan"]);
    expect(await names({ search: c.referenceNumber })).toEqual(["Meera Nair"]);
    expect(await names({ search: (await getApplication(db, w.hr, b.id)).candidate.email })).toEqual(["Aman Gupta"]);
    expect(await names({ jobId: job2.id })).toEqual(["Meera Nair"]);
    expect(await names({ stage: "SHORTLISTED" })).toEqual(["Aman Gupta"]);
    expect(await names({ recruiter: w.rec1User.id })).toEqual(["Zoya Khan"]);
    expect(await names({ recruiter: "unassigned" })).toEqual(["Meera Nair", "Aman Gupta"]);
    expect(await names({ from: "2026-11-16" })).toEqual(["Meera Nair"]);
    expect(await names({ to: "2026-11-15" })).toEqual(["Aman Gupta", "Zoya Khan"]);
    expect(await names({ from: "2026-11-15", to: "2026-11-15", stage: "APPLIED" })).toEqual(["Zoya Khan"]);

    const board = await listPipeline(db, w.hr, { jobId: w.job.id }, TZ);
    expect(board.map((col) => [col.stage, col.total]).filter(([, n]) => n !== 0)).toEqual([["APPLIED", 1], ["SHORTLISTED", 1]]);
    expect(board).toHaveLength(8);
  });

  it("flags a possible duplicate person without merging, and saves HR notes", async () => {
    const w = await world();
    const first = person({ phone: "9812345678" });
    const a = await applyPublicly(w.deps, w.target(w.job), first, resume());
    const job2 = await w.makeJob({ title: "Cashier" });
    const b = await applyPublicly(w.deps, w.target(job2), person({ phone: "+91 98123 45678", fullName: "Asha V." }), resume());
    const appA = await getApplication(db, w.hr, a.id);
    const appB = await getApplication(db, w.hr, b.id);
    expect(appA.candidate.id).not.toBe(appB.candidate.id); // different email: kept as two people
    const candidate = await getCandidate(db, w.hr, appA.candidate.id);
    expect(candidate.possibleDuplicates).toEqual([{ id: appB.candidate.id, name: "Asha V.", email: appB.candidate.email }]);

    await updateCandidateNotes(w.deps, w.hr, appA.candidate.id, "  Good attitude. Call again in March. ");
    expect((await getCandidate(db, w.hr, appA.candidate.id)).notes).toBe("Good attitude. Call again in March.");
    expect(w.entries.at(-1)).toMatchObject({ action: "candidate.notes_updated" });
  });

  it("treats malformed ids as not found", async () => {
    const w = await world();
    await expect(getApplication(db, w.hr, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(getCandidate(db, w.hr, "'; drop table users; --")).rejects.toMatchObject({ code: "not_found" });
    await expect(readDocument(w.deps, w.hr, "../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
  });
});
