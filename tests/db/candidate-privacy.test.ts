// Candidate privacy and retention (migration 20261117000000_candidate_privacy), against the DISPOSABLE test
// database only: notice settings, the age confirmation, no applicant IP address, removing a candidate's personal
// data (alone, or shared with another organisation), who may do it, and the due-for-removal list.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { type ApplicationInput, parseApplicationInput } from "@/lib/recruitment/application-input";
import {
  addApplicationNote,
  type AppDeps,
  applyPublicly,
  countApplicationsByStage,
  createApplicationManually,
  getApplication,
  listApplications,
  moveApplicationStage,
  type ResumeUpload,
} from "@/lib/recruitment/applications";
import { getCandidate, listCandidates, updateCandidateNotes } from "@/lib/recruitment/candidates";
import { readDocument } from "@/lib/recruitment/documents";
import { getPrivacySettings, listDueForRemoval, removeCandidate, updatePrivacySettings } from "@/lib/recruitment/privacy";
import { PRIVACY_NOTICE_VERSION } from "@/lib/recruitment/privacy-rules";
import { getPublicOrganization } from "@/lib/recruitment/public-jobs";
import type { FileStorage } from "@/lib/recruitment/storage";
import { realRoleIds } from "./roles-helper";
import { giveSession, pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const now = new Date("2026-11-17T06:00:00.000Z");
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "privacy-test.example.test";
const AGE_OK = { ageConfirmed: true } as const;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const resume = (): ResumeUpload => ({ bytes: PDF, kind: { extension: "pdf", mimeType: "application/pdf" }, safeName: "cv.pdf" });

function person(overrides: Record<string, string> = {}): ApplicationInput {
  const r = parseApplicationInput({
    fullName: "Kavya Rao",
    email: `kavya-${rnd()}@${DOMAIN}`,
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    city: "Indore",
    institution: "DAVV",
    degree: "BBA",
    graduationYear: "2024",
    skills: "Espresso, Latte art",
    experienceCompany: "Cafe Uno",
    experienceTitle: "Barista",
    ...overrides,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe.skipIf(!enabled)("candidate privacy and retention (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client; // owner connection for direct checks
  let rt: Client; // the app's account, for direct database calls
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
    if (owner) {
      await owner.candidateDocument.deleteMany({ where: { organizationId: { in: orgIds } } });
      await raw.query("BEGIN");
      await raw.query(`ALTER TABLE application_status_history DISABLE TRIGGER application_status_history_no_update`);
      await raw.query(`DELETE FROM application_status_history WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`ALTER TABLE application_status_history ENABLE TRIGGER application_status_history_no_update`);
      await raw.query("COMMIT");
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
      await owner.$disconnect();
    }
    await db?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  // An organisation with a Super Admin, an HR Manager and an Employee, a published job, files in memory.
  async function world() {
    const user = async (name: string) => {
      const u = await owner.user.create({ data: { email: `${name.toLowerCase()}-${rnd()}@${DOMAIN}`, name } });
      userIds.push(u.id);
      return u;
    };
    const [sa, hr, emp] = [await user("Sana"), await user("Harish"), await user("Esha")];
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: `Privacy Org ${rnd()}`, ownerUserId: sa.id, timezone: "Asia/Kolkata" } });
    orgIds.push(org.id);
    for (const [u, key] of [[sa, "SUPER_ADMIN"], [hr, "HR_MANAGER"], [emp, "EMPLOYEE"]] as const) {
      await owner.organizationMember.create({ data: { organizationId: org.id, userId: u.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role[key] }] } } });
    }
    const makeJob = (title: string) =>
      owner.jobOpening.create({
        data: { organizationId: org.id, slug: `job-${rnd()}`, title, description: "Test job.", employmentType: "FULL_TIME", workMode: "ON_SITE", createdById: sa.id, status: "PUBLISHED", publishedAt: now },
      });
    const job = await makeJob("Barista");
    const files = new Map<string, Uint8Array>();
    const storage: FileStorage = { put: async (k, b) => void files.set(k, b), get: async (k) => files.get(k) ?? null, remove: async (k) => void files.delete(k) };
    const entries: AuditEntry[] = [];
    const deps: AppDeps = { db, now, writeAudit: async (_d, e) => void entries.push(e), client: { ipAddress: "203.0.113.77", userAgent: "vitest-browser" }, storage };
    const ctx = (u: { id: string; email: string; name: string }, key: RoleKey): AuthContext => ({
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: u.id, email: u.email, name: u.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId: null, expiresAt: now, absoluteExpiresAt: now, roleKeys: [key], permissions: new Set(ROLE_PERMISSIONS[key]),
    });
    return {
      org, job, makeJob, deps, files, entries, users: { sa, hr, emp },
      sa: await giveSession(owner, ctx(sa, "SUPER_ADMIN")),
      hr: await giveSession(owner, ctx(hr, "HR_MANAGER")),
      emp: await giveSession(owner, ctx(emp, "EMPLOYEE")),
      target: (j: { slug: string }) => ({ organizationSlug: org.slug, jobSlug: j.slug }),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  // A public application, then rejected with a personal reason, with notes on the application and the person.
  async function rejectedApplicant(w: World, input = person(), job = w.job) {
    const app = await applyPublicly(w.deps, w.target(job), input, resume(), AGE_OK);
    await addApplicationNote(w.deps, w.hr, app.id, "Seemed nervous; mentioned a family situation.");
    await moveApplicationStage(w.deps, w.hr, app.id, "REJECTED", "Not available on weekends because of a personal matter.");
    const oc = (await owner.application.findUniqueOrThrow({ where: { id: app.id }, select: { organizationCandidateId: true } })).organizationCandidateId;
    await updateCandidateNotes(w.deps, w.hr, oc, "Lives near the Vijay Nagar branch.");
    return { app, oc, input };
  }

  // ---------------------------------------------------------------------------
  it("gives HR Managers the right to remove candidates, in the role definition and in the database", async () => {
    expect(ROLE_PERMISSIONS.HR_MANAGER).toContain("candidate:delete");
    expect(ROLE_PERMISSIONS.EMPLOYEE).not.toContain("candidate:delete");
    const rows = (await raw.query(`SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'candidate:delete' ORDER BY 1`)).rows.map((r) => r.key);
    expect(rows).toEqual(["HR_MANAGER", "SUPER_ADMIN"]);
  });

  it("lets only a Super Admin change the privacy notice settings, validates them, and shows them publicly", async () => {
    const w = await world();
    const before = await getPrivacySettings(db, w.hr);
    expect(before).toMatchObject({ noticeName: null, contactEmail: null, retentionMonths: 12, canEdit: false, canRemove: true });
    await expect(updatePrivacySettings(w.deps, w.hr, { noticeName: "X", contactEmail: "", retentionMonths: "12" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePrivacySettings(w.deps, w.emp, { noticeName: "X", contactEmail: "", retentionMonths: "12" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePrivacySettings(w.deps, w.sa, { noticeName: "TheTrustCoffee", contactEmail: "not-an-email", retentionMonths: "0" })).rejects.toMatchObject({
      fieldErrors: { contactEmail: expect.any(String), retentionMonths: expect.any(String) },
    });
    await updatePrivacySettings(w.deps, w.sa, { noticeName: "  TheTrustCoffee ", contactEmail: "Privacy@Example.TEST", retentionMonths: "6" });
    expect(await getPrivacySettings(db, w.sa)).toMatchObject({ noticeName: "TheTrustCoffee", contactEmail: "privacy@example.test", retentionMonths: 6, canEdit: true });
    expect(await getPublicOrganization(db, w.org.slug)).toMatchObject({ privacyNoticeName: "TheTrustCoffee", privacyContactEmail: "privacy@example.test", candidateRetentionMonths: 6 });
    // The audit record says what changed, without the contact address itself.
    expect(w.entries.at(-1)).toMatchObject({ action: "organization.privacy_settings_updated", metadata: { retentionMonths: 6, contactSet: true } });
    expect(JSON.stringify(w.entries)).not.toContain("privacy@example.test");
    // The database's own rules hold too.
    await expect(owner.organization.update({ where: { id: w.org.id }, data: { candidateRetentionMonths: 0 } })).rejects.toThrow();
    await expect(owner.organization.update({ where: { id: w.org.id }, data: { privacyContactEmail: "Upper@Example.test" } })).rejects.toThrow();
  });

  it("requires the age confirmation, records it, and stores no IP address or browser for a public application", async () => {
    const w = await world();
    await expect(applyPublicly(w.deps, w.target(w.job), person(), resume(), { ageConfirmed: false })).rejects.toMatchObject({ code: "invalid", fieldErrors: { ageConfirmed: expect.any(String) } });
    await expect(createApplicationManually(w.deps, w.hr, w.job.id, person(), null, { ageConfirmed: false })).rejects.toMatchObject({ fieldErrors: { ageConfirmed: expect.any(String) } });
    const pub = await applyPublicly(w.deps, w.target(w.job), person(), resume(), AGE_OK);
    const man = await createApplicationManually(w.deps, w.hr, w.job.id, person(), null, AGE_OK);
    const rows = await owner.application.findMany({ where: { id: { in: [pub.id, man.id] } }, select: { ageConfirmedAt: true, privacyNoticeVersion: true } });
    expect(rows.every((r) => r.ageConfirmedAt !== null && r.privacyNoticeVersion === PRIVACY_NOTICE_VERSION)).toBe(true);
    const audit = (await raw.query(`SELECT ip_address, user_agent FROM audit_logs WHERE action = 'application.submitted' AND entity_id = $1`, [pub.id])).rows;
    expect(audit).toEqual([{ ip_address: null, user_agent: null }]);
    // The database itself refuses an unconfirmed public application, even when called directly.
    await rt.query("BEGIN");
    await rt.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w.org.id]);
    const direct = await rt.query(`SELECT * FROM app_submit_public_application($1::uuid, 'R-${rnd()}', 'direct-${rnd()}@${DOMAIN}', 'Direct', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, 'v', now(), NULL, NULL, NULL, NULL, NULL, false)`, [w.job.id])
      .then(() => "allowed", (e: Error) => e.message);
    await rt.query("ROLLBACK");
    expect(direct).toMatch(/age_not_confirmed/);
  });

  it("removes a candidate known only to this organisation: files, details and notes go; stage history and counts stay", async () => {
    const w = await world();
    const { app, oc, input } = await rejectedApplicant(w);
    const profileId = (await owner.organizationCandidate.findUniqueOrThrow({ where: { id: oc }, select: { candidateId: true } })).candidateId;
    const docId = (await owner.candidateDocument.findFirstOrThrow({ where: { applicationId: app.id } })).id;
    expect(w.files.size).toBe(1);
    const historyBefore = await owner.applicationStatusHistory.count({ where: { applicationId: app.id } });
    const countsBefore = await countApplicationsByStage(db, w.hr, w.job.id);

    const result = await removeCandidate(w.deps, w.hr, oc); // an HR Manager may do it
    expect(result).toEqual({ applicationsKept: 1, filesDeleted: 1, filesNotDeleted: 0 });

    // Files: gone from storage, the record marked deleted without its name.
    expect(w.files.size).toBe(0);
    expect(await owner.candidateDocument.findUniqueOrThrow({ where: { id: docId } })).toMatchObject({ originalName: "removed", sha256: "", deletedAt: expect.any(Date) });
    // The profile itself is anonymised; education, experience and skills deleted.
    const profile = await owner.candidateProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(profile).toMatchObject({ fullName: "Removed candidate", phone: null, city: null, linkedinUrl: null, portfolioUrl: null, anonymizedAt: expect.any(Date) });
    expect(profile.email).toBe(`removed-${profileId}@removed.invalid`);
    for (const t of ["candidateEducation", "candidateExperience", "candidateSkill"] as const) {
      expect(await (owner[t] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { candidateId: profileId } }), t).toBe(0);
    }
    // The application keeps reference, job, stage and dates, but none of the submitted details.
    const kept = await owner.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(kept).toMatchObject({ stage: "REJECTED", profileSnapshot: null, source: null, rejectionReason: null, referenceNumber: app.referenceNumber });
    expect(await owner.applicationNote.count({ where: { applicationId: app.id } })).toBe(0);
    const history = await owner.applicationStatusHistory.findMany({ where: { applicationId: app.id } });
    expect(history).toHaveLength(historyBefore);
    expect(history.every((h) => h.reason === null)).toBe(true);
    expect(await owner.organizationCandidate.findUniqueOrThrow({ where: { id: oc } })).toMatchObject({ notes: null, tags: [], removedAt: expect.any(Date) });
    // Nothing anywhere still holds their name, email or phone.
    const dump = JSON.stringify(await raw.query(`SELECT row_to_json(x)::text AS t FROM (
      SELECT * FROM candidate_profiles WHERE id = $1) x`, [profileId]).then((r) => r.rows)) + JSON.stringify(kept) + JSON.stringify(history);
    for (const v of [input.fullName, input.email, input.phone]) expect(dump).not.toContain(v);

    // HR no longer sees the person anywhere; the job's numbers still count the application.
    expect((await listCandidates(db, w.hr, {})).items.map((c) => c.id)).not.toContain(oc);
    await expect(getCandidate(db, w.hr, oc)).rejects.toMatchObject({ code: "not_found" });
    expect((await listApplications(db, w.hr, {}, "Asia/Kolkata")).items.map((a) => a.id)).not.toContain(app.id);
    await expect(getApplication(db, w.hr, app.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(readDocument(w.deps, w.hr, docId)).rejects.toMatchObject({ code: "not_found" });
    expect(await countApplicationsByStage(db, w.hr, w.job.id)).toEqual(countsBefore);

    // The removal is recorded, with no personal data.
    const audit = (await raw.query(`SELECT actor_user_id, metadata FROM audit_logs WHERE action = 'candidate.removed' AND entity_id = $1`, [oc])).rows;
    expect(audit).toEqual([{ actor_user_id: w.users.hr.id, metadata: { applicationsKept: 1, filesDeleted: 1, profile: "anonymised" } }]);

    // Removing again finds nothing; the person can apply again, as someone new, even for the same job.
    await expect(removeCandidate(w.deps, w.sa, oc)).rejects.toMatchObject({ code: "not_found" });
    const again = await applyPublicly(w.deps, w.target(w.job), input, resume(), AGE_OK);
    expect(again.candidateWasKnown).toBe(false);
    expect((await getApplication(db, w.hr, again.id)).candidate.email).toBe(input.email);
  });

  it("leaves another organisation's data about the same person untouched", async () => {
    const [a, b] = [await world(), await world()];
    const input = person();
    const inA = await rejectedApplicant(a, input);
    const inB = await applyPublicly(b.deps, b.target(b.job), input, resume(), AGE_OK);
    const shared = (await owner.organizationCandidate.findUniqueOrThrow({ where: { id: inA.oc }, select: { candidateId: true } })).candidateId;

    await removeCandidate(a.deps, a.sa, inA.oc);

    // Organisation B still has the person, their profile and their resume.
    const bApp = await getApplication(db, b.hr, inB.id);
    expect(bApp.candidate.email).toBe(input.email);
    expect(bApp.documents).toHaveLength(1);
    expect(b.files.size).toBe(1);
    expect(await owner.candidateProfile.findUniqueOrThrow({ where: { id: shared } })).toMatchObject({ email: input.email, anonymizedAt: null });
    // Organisation A's record now points to a separate, anonymous profile: no link back to the person.
    const aRecord = await owner.organizationCandidate.findUniqueOrThrow({ where: { id: inA.oc }, include: { candidate: true } });
    expect(aRecord.candidateId).not.toBe(shared);
    expect(aRecord.candidate).toMatchObject({ fullName: "Removed candidate", anonymizedAt: expect.any(Date) });
    expect(a.files.size).toBe(0);
    const audit = (await raw.query(`SELECT metadata->>'profile' AS p FROM audit_logs WHERE action = 'candidate.removed' AND entity_id = $1`, [inA.oc])).rows;
    expect(audit).toEqual([{ p: "detached" }]);
  });

  it("refuses while an application is open, to Employees, without a session, and for another organisation's candidate", async () => {
    const w = await world();
    const open = await applyPublicly(w.deps, w.target(w.job), person(), resume(), AGE_OK);
    const oc = (await owner.application.findUniqueOrThrow({ where: { id: open.id }, select: { organizationCandidateId: true } })).organizationCandidateId;
    await expect(removeCandidate(w.deps, w.sa, oc)).rejects.toMatchObject({ code: "invalid" });
    await expect(removeCandidate(w.deps, w.emp, oc)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await world();
    await expect(removeCandidate(other.deps, other.sa, oc)).rejects.toMatchObject({ code: "not_found" });
    await expect(removeCandidate(w.deps, w.sa, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    // Directly in the database: an Employee's session, and no session at all, are refused.
    const call = async (settings: Record<string, string>) => {
      await rt.query("BEGIN");
      try {
        for (const [k, v] of Object.entries(settings)) await rt.query(`SELECT set_config($1, $2, true)`, [k, v]);
        await rt.query(`SELECT * FROM app_remove_candidate($1::uuid, now())`, [oc]);
        return "allowed";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await rt.query("ROLLBACK");
      }
    };
    expect(await call({ "app.mode": "staff", "app.session_token": await pgSessionToken(raw, w.users.emp.id, w.org.id) })).toMatch(/not allowed/);
    expect(await call({})).toMatch(/not allowed/);
    expect(await owner.organizationCandidate.findUniqueOrThrow({ where: { id: oc } })).toMatchObject({ removedAt: null });
  });

  it("lists as due only candidates whose applications all closed longer ago than the retention period", async () => {
    const w = await world();
    const job2 = await w.makeJob("Cashier");
    const old = await rejectedApplicant(w);
    const recent = await rejectedApplicant(w);
    const stillOpen = await rejectedApplicant(w);
    await applyPublicly(w.deps, w.target(job2), stillOpen.input, resume(), AGE_OK); // a second, open application
    const removed = await rejectedApplicant(w);
    const thirteenMonthsAgo = new Date(now.getTime() - 400 * 86_400_000);
    for (const x of [old, stillOpen, removed]) await owner.application.updateMany({ where: { organizationCandidateId: x.oc }, data: { stageChangedAt: thirteenMonthsAgo } });
    await removeCandidate(w.deps, w.sa, removed.oc);

    const due = await listDueForRemoval(db, w.hr, now);
    expect(due.retentionMonths).toBe(12);
    expect(due.items.map((d) => d.id)).toEqual([old.oc]);
    expect(due.items[0]).toMatchObject({ name: "Kavya Rao", applications: 1 });
    expect(due.items.map((d) => d.id)).not.toContain(recent.oc);
    // A shorter period brings the recent one in too.
    await updatePrivacySettings(w.deps, w.sa, { noticeName: "", contactEmail: "", retentionMonths: "1" });
    await owner.application.updateMany({ where: { organizationCandidateId: recent.oc }, data: { stageChangedAt: new Date(now.getTime() - 40 * 86_400_000) } });
    expect((await listDueForRemoval(db, w.hr, now)).items.map((d) => d.id).sort()).toEqual([old.oc, recent.oc].sort());
    await expect(listDueForRemoval(db, w.emp, now)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps stage history append-only: only a reason may be cleared, nothing else changed", async () => {
    const w = await world();
    const { app } = await rejectedApplicant(w);
    const row = (await raw.query(`SELECT id FROM application_status_history WHERE application_id = $1 AND reason IS NOT NULL`, [app.id])).rows[0];
    const attempt = async (sql: string) => {
      await raw.query("BEGIN");
      try {
        await raw.query(sql, [row.id]);
        return "allowed";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await raw.query("ROLLBACK");
      }
    };
    expect(await attempt(`UPDATE application_status_history SET reason = NULL WHERE id = $1`)).toBe("allowed");
    expect(await attempt(`UPDATE application_status_history SET reason = 'changed' WHERE id = $1`)).toMatch(/append-only/);
    expect(await attempt(`UPDATE application_status_history SET to_stage = 'SELECTED' WHERE id = $1`)).toMatch(/append-only/);
    expect(await attempt(`UPDATE application_status_history SET reason = NULL, to_stage = 'SELECTED' WHERE id = $1`)).toMatch(/append-only/);
    // The app's own account cannot update the history at all.
    await rt.query("BEGIN");
    const byApp = await rt.query(`UPDATE application_status_history SET reason = NULL WHERE id = $1`, [row.id]).then(() => "allowed", (e: Error) => e.message);
    await rt.query("ROLLBACK");
    expect(byApp).toMatch(/permission denied/);
  });
});
