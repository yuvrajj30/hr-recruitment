// Tests the job openings service against the DISPOSABLE test database only.
// The audit writer is replaced by a recorder (real audit rows can never be deleted).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { createDb, type Db } from "@/lib/db";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { type JobInput, parseJobInput } from "@/lib/recruitment/job-input";
import { changeJobStatus, countJobsByStatus, createJob, getJob, listJobs, updateJob } from "@/lib/recruitment/jobs";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const now = new Date("2026-11-15T06:00:00.000Z");
const rnd = () => randomBytes(4).toString("hex");
const ALL = ["job:read", "job:create", "job:update", "job:publish", "job:close"];

function input(overrides: Record<string, string> = {}): JobInput {
  const r = parseJobInput({
    title: "Barista",
    description: "Prepare espresso drinks and keep the bar spotless.",
    employmentType: "FULL_TIME",
    workMode: "ON_SITE",
    visibility: "PUBLIC",
    ...overrides,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe.skipIf(!enabled)("job openings service (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.jobOpening.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.department.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  async function world(permissions: string[] = ALL) {
    const user = await owner.user.create({ data: { email: `jobs-test-${rnd()}@example.test`, name: "Jobs Test" } });
    userIds.push(user.id);
    const org = await owner.organization.create({
      data: { slug: `t-${rnd()}${rnd()}`, name: `Org ${rnd()}`, ownerUserId: user.id, timezone: "Asia/Kolkata", defaultCurrency: "INR" },
    });
    orgIds.push(org.id);
    const ctx: AuthContext = {
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId: null,
      expiresAt: now,
      absoluteExpiresAt: now,
      roleKeys: [],
      permissions: new Set(permissions),
    };
    const entries: AuditEntry[] = [];
    const deps = {
      db,
      now,
      writeAudit: async (_db: unknown, e: AuditEntry) => void entries.push(e),
      client: { ipAddress: "203.0.113.9", userAgent: "vitest" },
    };
    return { user, org, ctx, deps, entries };
  }

  it("creates a draft with a unique slug, the org currency and an audit entry", async () => {
    const w = await world();
    const a = await createJob(w.deps, w.ctx, input({ applicationDeadline: "2026-12-31", compensationMin: "18000", compensationPeriod: "per month" }));
    const b = await createJob(w.deps, w.ctx, input());
    const ja = await getJob(db, w.ctx, a.id);
    const jb = await getJob(db, w.ctx, b.id);
    expect(ja).toMatchObject({ status: "DRAFT", slug: "barista", compensationCurrency: "INR", compensationMin: "18000.00", applicationDeadlineDate: "2026-12-31" });
    expect(ja.applicationDeadline?.toISOString()).toBe("2026-12-31T18:29:59.999Z");
    expect(jb.slug).toBe("barista-2");
    expect(w.entries.map((e) => e.action)).toEqual(["job.created", "job.created"]);
    expect(w.entries[0]).toMatchObject({ organizationId: w.org.id, actorUserId: w.user.id, entityId: a.id });
  });

  it("never shows or changes another organisation's jobs", async () => {
    const mine = await world();
    const theirs = await world();
    const job = await createJob(theirs.deps, theirs.ctx, input({ title: "Secret role" }));
    expect(await listJobs(db, mine.ctx)).toEqual([]);
    await expect(getJob(db, mine.ctx, job.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateJob(mine.deps, mine.ctx, job.id, input())).rejects.toMatchObject({ code: "not_found" });
    await expect(changeJobStatus(mine.deps, mine.ctx, job.id, "publish")).rejects.toMatchObject({ code: "not_found" });
    expect((await getJob(db, theirs.ctx, job.id)).status).toBe("DRAFT");
  });

  it("rejects a department from another organisation", async () => {
    const mine = await world();
    const theirs = await world();
    const dept = await owner.department.create({ data: { organizationId: theirs.org.id, name: "Kitchen" } });
    await expect(createJob(mine.deps, mine.ctx, input({ departmentId: dept.id }))).rejects.toMatchObject({ code: "invalid" });
    const own = await owner.department.create({ data: { organizationId: mine.org.id, name: "Bar" } });
    const job = await createJob(mine.deps, mine.ctx, input({ departmentId: own.id }));
    expect((await getJob(db, mine.ctx, job.id)).departmentName).toBe("Bar");
  });

  it("checks permissions before anything else", async () => {
    const w = await world(["job:read"]);
    await expect(createJob(w.deps, w.ctx, input())).rejects.toBeInstanceOf(ForbiddenError);
    const none = await world([]);
    await expect(listJobs(db, none.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    const full = await world();
    const job = await createJob(full.deps, full.ctx, input());
    const noClose = { ...full.ctx, permissions: new Set(["job:read", "job:publish"]) };
    await changeJobStatus(full.deps, noClose, job.id, "publish");
    await expect(changeJobStatus(full.deps, noClose, job.id, "close")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("moves through the life cycle and records the dates", async () => {
    const w = await world();
    const { id } = await createJob(w.deps, w.ctx, input());
    await expect(changeJobStatus(w.deps, w.ctx, id, "close")).rejects.toMatchObject({ code: "conflict" });
    await changeJobStatus(w.deps, w.ctx, id, "publish");
    let job = await getJob(db, w.ctx, id);
    expect(job).toMatchObject({ status: "PUBLISHED", publishedAt: now, closedAt: null });
    const later = { ...w.deps, now: new Date(now.getTime() + 60_000) };
    await changeJobStatus(later, w.ctx, id, "close");
    job = await getJob(db, w.ctx, id);
    expect(job).toMatchObject({ status: "CLOSED", closedAt: later.now, publishedAt: now });
    await changeJobStatus(later, w.ctx, id, "archive");
    await expect(updateJob(later, w.ctx, id, input())).rejects.toBeInstanceOf(RecruitmentError);
    await expect(changeJobStatus(later, w.ctx, id, "reopen")).rejects.toMatchObject({ code: "conflict" });
    expect(await countJobsByStatus(db, w.ctx)).toEqual({ DRAFT: 0, PUBLISHED: 0, CLOSED: 0, ARCHIVED: 1 });
    expect(await listJobs(db, w.ctx, { status: "ACTIVE" })).toEqual([]);
  });

  it("will not publish a job whose deadline has passed", async () => {
    const w = await world();
    const { id } = await createJob(w.deps, w.ctx, input({ applicationDeadline: "2026-11-01" }));
    await expect(changeJobStatus(w.deps, w.ctx, id, "publish")).rejects.toMatchObject({ code: "invalid" });
    await updateJob(w.deps, w.ctx, id, input({ applicationDeadline: "2026-12-01" }));
    await changeJobStatus(w.deps, w.ctx, id, "publish");
    await expect(updateJob(w.deps, w.ctx, id, input({ applicationDeadline: "2026-11-01" }))).rejects.toMatchObject({ code: "invalid" });
  });

  it("updates the fields and searches by title", async () => {
    const w = await world();
    const { id } = await createJob(w.deps, w.ctx, input());
    await updateJob(w.deps, w.ctx, id, input({ title: "Head Barista", requiredSkills: "Latte art, Training", openingsCount: "2" }));
    const job = await getJob(db, w.ctx, id);
    expect(job).toMatchObject({ title: "Head Barista", slug: "barista", requiredSkills: ["Latte art", "Training"], openingsCount: 2 });
    expect((await listJobs(db, w.ctx, { search: "head" })).map((j) => j.id)).toEqual([id]);
    expect(await listJobs(db, w.ctx, { search: "manager" })).toEqual([]);
  });

  it("treats a malformed id as not found", async () => {
    const w = await world();
    await expect(getJob(db, w.ctx, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
  });
});
