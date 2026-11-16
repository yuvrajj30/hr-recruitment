// Timestamps must mean the same instant everywhere: in the app, in the database, and in any database-side
// check (invitation expiry, application deadlines). These tests run against the DISPOSABLE test database.
//
// Background: the PostgreSQL server is configured for Asia/Calcutta, and the Prisma pg adapter sends and
// reads timestamptz values without their offset. With a non-UTC session that shifts stored values by the
// zone's offset. Connections must therefore use UTC (createDb does by default).
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import type { AuthContext } from "@/lib/auth/context";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { parseApplicationInput } from "@/lib/recruitment/application-input";
import { type AppDeps, applyPublicly } from "@/lib/recruitment/applications";
import { formatDate } from "@/lib/recruitment/labels";
import type { FileStorage } from "@/lib/recruitment/storage";
import { acceptInvitation, lookupInvitation } from "@/lib/users/accept";
import { createInvitation } from "@/lib/users/members";
import { getMyAccount } from "@/lib/users/self";
import { realRoleIds } from "./roles-helper";
import { bindSessionToken } from "@/lib/auth/session-binding";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "tz-test.example.test";
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const memoryStorage = (): FileStorage => {
  const files = new Map<string, Uint8Array>();
  return { put: async (k, b) => void files.set(k, b), get: async (k) => files.get(k) ?? null, remove: async (k) => void files.delete(k) };
};

describe.skipIf(!enabled)("timestamps and time zones (test database)", () => {
  let owner: Db;
  let db: Db; // the app's account, UTC sessions (the fix)
  let legacyDb: Db; // the app's account, the server's own time zone (the old behaviour)
  let ownerLegacy: Db; // the owner account through a legacy connection (to set up rows written the old way)
  let raw: Client;
  let serverOffsetMinutes = 0;
  let role: Record<RoleKey, string>;
  const orgIds: string[] = [];

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
    legacyDb = createDb(runtimeUrl!, { max: 2, sessionTimeZone: null });
    ownerLegacy = createDb(ownerUrl!, { max: 1, sessionTimeZone: null });
    raw = new Client({ connectionString: ownerUrl });
    await raw.connect();
    role = await realRoleIds(owner);
    // How far the server's configured zone is from UTC right now (330 minutes for Asia/Calcutta).
    const r = await raw.query(`SELECT EXTRACT(EPOCH FROM (now() AT TIME ZONE current_setting('TimeZone')) - (now() AT TIME ZONE 'UTC'))::int / 60 AS m`);
    serverOffsetMinutes = r.rows[0].m;
  });
  afterAll(async () => {
    if (owner) {
      await owner.candidateDocument.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.application.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organizationCandidate.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.candidateProfile.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
      await owner.jobOpening.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.staffInvitation.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.session.deleteMany({ where: { user: { email: { endsWith: `@${DOMAIN}` } } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds); // an accepted invitation is audited by the database itself
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
    await legacyDb?.$disconnect();
    await ownerLegacy?.$disconnect();
    await raw?.end();
  });

  // PostgreSQL's own rendering of a stored instant, in UTC: the reference, independent of the adapter.
  const storedUtc = async (sql: string, params: unknown[]) => (await raw.query(`SELECT to_char((${sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`, params)).rows[0]?.t as string;

  async function world() {
    const admin = await owner.user.create({ data: { email: `admin-${rnd()}@${DOMAIN}`, name: "Admin" } });
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: "TZ Org", ownerUserId: admin.id, timezone: "Asia/Kolkata" } });
    orgIds.push(org.id);
    const member = await owner.organizationMember.create({ data: { organizationId: org.id, userId: admin.id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role.SUPER_ADMIN }] } } });
    const ctx: AuthContext = {
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: admin.id, email: admin.email, name: admin.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId: member.id, expiresAt: new Date(), absoluteExpiresAt: new Date(), roleKeys: ["SUPER_ADMIN"], permissions: new Set(ROLE_PERMISSIONS.SUPER_ADMIN),
    };
    await giveSession(owner, ctx);
    const entries: AuditEntry[] = [];
    const writeAudit = async (_db: unknown, e: AuditEntry) => void entries.push(e);
    return { admin, org, ctx, writeAudit };
  }

  it("stores exactly the instant the app writes, and reads it back unchanged", async () => {
    const T = new Date("2026-11-15T12:00:00.000Z");
    const u = await owner.user.create({ data: { email: `w-${rnd()}@${DOMAIN}`, name: "Writer", lastLoginAt: T }, select: { id: true } });
    expect(await storedUtc(`SELECT last_login_at FROM users WHERE id = $1`, [u.id])).toBe("2026-11-15T12:00:00.000Z");
    expect((await owner.user.findUniqueOrThrow({ where: { id: u.id } })).lastLoginAt).toEqual(T);
    // createdAt / updatedAt are filled by Prisma itself: they must be "now" too, not shifted.
    const row = await owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(Date.parse(await storedUtc(`SELECT created_at FROM users WHERE id = $1`, [u.id])) - Date.now())).toBeLessThan(60_000);
  });

  it("reads times generated by PostgreSQL itself (now()) as the same instant", async () => {
    const r = await raw.query(`INSERT INTO users (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, 'DB clock', now()) RETURNING id`, [`dbclock-${rnd()}@${DOMAIN}`]);
    const row = await owner.user.findUniqueOrThrow({ where: { id: r.rows[0].id } });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("documents the old behaviour: a non-UTC session shifts what is stored by the server's offset", async () => {
    if (serverOffsetMinutes === 0) return; // a UTC-configured server would not show the problem
    const T = new Date("2026-11-15T12:00:00.000Z");
    const u = await ownerLegacy.user.create({ data: { email: `legacy-${rnd()}@${DOMAIN}`, name: "Legacy", lastLoginAt: T }, select: { id: true } });
    const stored = Date.parse(await storedUtc(`SELECT last_login_at FROM users WHERE id = $1`, [u.id]));
    expect((T.getTime() - stored) / 60_000).toBe(serverOffsetMinutes);
    // The same row read by a correctly configured (UTC) app shows the stored, shifted instant.
    expect((await owner.user.findUniqueOrThrow({ where: { id: u.id } })).lastLoginAt?.getTime()).toBe(stored);
  });

  it("expires invitations exactly 7 days after they are created, as seen by the database", async () => {
    const w = await world();
    const now = new Date();
    const inv = await createInvitation({ db, now, writeAudit: w.writeAudit, client: { ipAddress: null, userAgent: "vitest" }, appOrigin: "https://x.test" }, w.ctx, { email: `inv-${rnd()}@${DOMAIN}`, name: "Invitee", role: "EMPLOYEE" });
    const stored = Date.parse(await storedUtc(`SELECT expires_at FROM staff_invitations WHERE id = $1`, [inv.id]));
    expect(stored).toBe(now.getTime() + 7 * 86_400_000);
    const token = inv.link.split("/invite/")[1]!;
    expect(await lookupInvitation(db, token)).not.toBeNull();
    // One minute before the real expiry it still works; one second after, the database refuses it.
    await raw.query(`UPDATE staff_invitations SET expires_at = now() + interval '1 minute' WHERE id = $1`, [inv.id]);
    expect(await lookupInvitation(db, token)).not.toBeNull();
    await raw.query(`UPDATE staff_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 second' WHERE id = $1`, [inv.id]);
    expect(await lookupInvitation(db, token)).toBeNull();
    await expect(acceptInvitation({ db, now: new Date(), timings, client: { ipAddress: null, userAgent: null } }, token, { name: "Late", password: "Long-Enough-Pass-77", confirmPassword: "Long-Enough-Pass-77" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("accepts public applications right up to the job's deadline (app and database agree)", async () => {
    const w = await world();
    // A deadline two hours from now: inside the window, but less than the 5h30 shift of the old behaviour.
    const deadline = new Date(Date.now() + 2 * 3_600_000);
    // Jobs are set up with the owner account (row-level security keeps the app account out without a staff identity).
    const job = await owner.jobOpening.create({
      data: { organizationId: w.org.id, slug: `job-${rnd()}`, title: "Deadline Job", description: "A job with a deadline soon.", employmentType: "FULL_TIME", workMode: "ON_SITE", status: "PUBLISHED", publishedAt: new Date(), applicationDeadline: deadline, createdById: w.admin.id },
    });
    expect(Date.parse(await storedUtc(`SELECT application_deadline FROM job_openings WHERE id = $1`, [job.id]))).toBe(deadline.getTime());
    const input = (tag: string) => {
      const r = parseApplicationInput({ fullName: "Deadline Person", email: `${tag}-${rnd()}@${DOMAIN}`, phone: "9876543210" });
      if (!r.ok) throw new Error("bad input");
      return r.value;
    };
    const resume = { bytes: PDF, kind: { extension: "pdf" as const, mimeType: "application/pdf" }, safeName: "cv.pdf" };
    const deps = (client: Db): AppDeps => ({ db: client, now: new Date(), writeAudit: w.writeAudit, client: { ipAddress: null, userAgent: null }, storage: memoryStorage() });
    const target = { organizationSlug: w.org.slug, jobSlug: job.slug };
    const ok = await applyPublicly(deps(db), target, input("utc"), resume);
    expect(ok.referenceNumber).toMatch(/^APP-/);
    if (serverOffsetMinutes > 120) {
      // The old behaviour: the app thinks the job is open, but the database sees the deadline as passed.
      const legacyJob = await ownerLegacy.jobOpening.create({
        data: { organizationId: w.org.id, slug: `job-${rnd()}`, title: "Legacy Deadline Job", description: "Written through a legacy connection.", employmentType: "FULL_TIME", workMode: "ON_SITE", status: "PUBLISHED", publishedAt: new Date(), applicationDeadline: deadline, createdById: w.admin.id },
      });
      await expect(applyPublicly(deps(legacyDb), { organizationSlug: w.org.slug, jobSlug: legacyJob.slug }, input("legacy"), resume)).rejects.toThrow();
    }
  });

  it("shows the date a person joined as the same calendar day in the organisation's time zone", async () => {
    const w = await world();
    const now = new Date();
    const inv = await createInvitation({ db, now, writeAudit: w.writeAudit, client: { ipAddress: null, userAgent: null }, appOrigin: "https://x.test" }, w.ctx, { email: `join-${rnd()}@${DOMAIN}`, name: "Joiner", role: "EMPLOYEE" });
    const accepted = await acceptInvitation({ db, now, timings, client: { ipAddress: null, userAgent: null } }, inv.link.split("/invite/")[1]!, { name: "Joiner", password: "Long-Enough-Pass-77", confirmPassword: "Long-Enough-Pass-77" });
    const joiner = await owner.user.findUniqueOrThrow({ where: { id: accepted.userId } });
    const ctx: AuthContext = { ...w.ctx, user: { id: joiner.id, email: joiner.email, name: joiner.name, isPlatformAdmin: false }, roleKeys: ["EMPLOYEE"], permissions: new Set(ROLE_PERMISSIONS.EMPLOYEE) };
    bindSessionToken(ctx, accepted.sessionToken); // the session created by accepting the invitation
    const me = await getMyAccount(db, ctx);
    // joined_at is written by PostgreSQL's now(); it must display as today, not tomorrow.
    expect(Math.abs(me.memberSince!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(formatDate(me.memberSince!, "Asia/Kolkata")).toBe(formatDate(new Date(), "Asia/Kolkata"));
  });
});
