// Tests the whole login decision against the DISPOSABLE test database only (names ending "_test").
//   - app code runs as the restricted hr_runtime account; test data is made/removed by the owner account
//   - a fake clock drives every time rule
//   - most tests use a fast stand-in for the password check (and record how it was called);
//     one test uses the real bcrypt check end to end
//
// The audit log can never be deleted (by design), so only ONE test writes a real audit row, using one
// fixed user and organization that are re-used on every run. Everything else is cleaned up afterwards.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import { loginWithPassword, type LoginDeps, type LoginInput, signInWithDatabase } from "@/lib/auth/login-service";
import { validateSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { hashPassword } from "@/lib/security/password";
import { hashIdentifier } from "@/lib/security/tokens";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const t0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const timings = sessionTimings({
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_HOURS: 12,
  SESSION_TOUCH_INTERVAL_SECONDS: 60,
});
const SECRET = "unit-test-secret-".repeat(3); // at least 32 characters
const PASSWORD = "Correct-Horse-Battery-9";
// A real bcrypt hash (the database checks passwords itself now); a low cost keeps the tests quick.
const FAKE_HASH = bcrypt.hashSync(PASSWORD, 4);
const INVALID = { ok: false, reason: "invalid_credentials" } as const;

describe.skipIf(!enabled)("login service (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  const hashes: string[] = [];
  const ips: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.authLoginAttempt.deleteMany({
        where: { OR: [{ identifierHash: { in: hashes } }, { ipAddress: { in: ips } }] },
      });
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  // The real sign-in step (the database checks the password), with every call recorded.
  function stubDeps(overrides: Partial<LoginDeps> = {}) {
    const calls: { plain: string }[] = [];
    const deps: LoginDeps = {
      signIn: async (tx, a) => {
        calls.push({ plain: a.password });
        return signInWithDatabase(tx, a);
      },
      writeAudit: async () => {},
      ...overrides,
    };
    return { calls, deps };
  }

  const newIp = () => {
    const r = () => randomBytes(1)[0];
    const ip = `10.${r()}.${r()}.${r()}`;
    ips.push(ip);
    return ip;
  };
  const track = (email: string) => {
    hashes.push(hashIdentifier(email, SECRET));
    return email;
  };

  async function makeUser(opts: { status?: "ACTIVE" | "DISABLED"; passwordHash?: string | null } = {}) {
    const tag = randomBytes(5).toString("hex");
    const email = track(`login-test-${tag}@example.test`);
    const user = await owner.user.create({
      data: {
        email,
        name: "Login Test",
        status: opts.status ?? "ACTIVE",
        passwordHash: opts.passwordHash === undefined ? FAKE_HASH : opts.passwordHash,
      },
    });
    userIds.push(user.id);
    return { user, email, tag };
  }
  async function makeOrg(ownerUserId: string, tag: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
    const org = await owner.organization.create({
      data: { slug: `t-${tag}-${randomBytes(2).toString("hex")}`, name: `Org ${tag}`, ownerUserId, status },
    });
    orgIds.push(org.id);
    return org;
  }
  async function makeMember(
    organizationId: string,
    userId: string,
    status: "ACTIVE" | "INVITED" | "SUSPENDED" = "ACTIVE",
    createdAt?: Date,
  ) {
    return owner.organizationMember.create({
      data: { organizationId, userId, status, joinedAt: t0, ...(createdAt ? { createdAt } : {}) },
    });
  }
  // A normal, working account: ACTIVE user, ACTIVE organization, ACTIVE membership.
  async function fixture(opts: Parameters<typeof makeUser>[0] = {}) {
    const u = await makeUser(opts);
    const org = await makeOrg(u.user.id, u.tag);
    const member = await makeMember(org.id, u.user.id);
    return { ...u, org, member };
  }

  const attempt = (
    deps: LoginDeps,
    email: string,
    over: Partial<LoginInput> = {},
  ) =>
    loginWithPassword(
      db,
      { email, password: PASSWORD, ipAddress: newIp(), userAgent: "vitest", now: t0, timings, authSecret: SECRET, ...over },
      deps,
    );

  const attemptRows = (email: string) =>
    owner.authLoginAttempt.findMany({ where: { identifierHash: hashIdentifier(email, SECRET) } });

  // -------------------------------------------------------------------------
  describe("a good login", () => {
    it("signs the person in and returns a working session", async () => {
      const f = await fixture();
      const { deps, calls } = stubDeps();
      const ip = newIp();
      const r = await attempt(deps, f.email, { ipAddress: ip });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.user).toEqual({ id: f.user.id, email: f.email, name: "Login Test" });
      expect(r.organization).toEqual({ id: f.org.id, name: f.org.name, slug: f.org.slug });
      expect(r.expiresAt).toEqual(at(60 * MIN));
      expect(r.absoluteExpiresAt).toEqual(at(12 * 60 * MIN));
      expect(calls).toEqual([{ plain: PASSWORD }]);

      // The token really works...
      const v = await validateSession(db, r.token, { now: at(MIN), timings, touch: false });
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.principal.user.id).toBe(f.user.id);
        expect(v.principal.organization?.id).toBe(f.org.id);
        expect(v.principal.memberId).toBe(f.member.id);
      }
      // ...the session row remembers where it came from...
      const session = await owner.session.findUniqueOrThrow({ where: { id: r.sessionId } });
      expect(session.ipAddress).toBe(ip);
      expect(session.userAgent).toBe("vitest");
      expect(session.activeOrganizationId).toBe(f.org.id);
      // ...and the last-login time and the attempt record are updated.
      expect((await owner.user.findUniqueOrThrow({ where: { id: f.user.id } })).lastLoginAt).toEqual(t0);
      const rows = await attemptRows(f.email);
      expect(rows).toHaveLength(1);
      expect(rows[0].succeeded).toBe(true);
    });
    it("ignores capital letters and spaces around the email", async () => {
      const f = await fixture();
      const r = await attempt(stubDeps().deps, `  ${f.email.toUpperCase()} `);
      expect(r.ok).toBe(true);
    });
    it("gives every login its own new session token", async () => {
      const f = await fixture();
      const { deps } = stubDeps();
      const a = await attempt(deps, f.email);
      const b = await attempt(deps, f.email, { now: at(1000) });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.token).not.toBe(b.token);
    });
    it("stores only a keyed hash of the email in the attempts table, never the email", async () => {
      const f = await fixture();
      await attempt(stubDeps().deps, f.email);
      const rows = await attemptRows(f.email);
      expect(rows[0].identifierHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].identifierHash).not.toContain("login-test");
      const plain = await owner.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth_login_attempts WHERE identifier_hash = ${f.email}`;
      expect(plain[0].n).toBe(0);
    });
    it("works with the real password check too (bcrypt)", async () => {
      const passwordHash = await hashPassword(PASSWORD);
      const f = await fixture({ passwordHash });
      const deps: LoginDeps = { signIn: signInWithDatabase, writeAudit: async () => {} };
      expect((await attempt(deps, f.email)).ok).toBe(true);
      expect(await attempt(deps, f.email, { password: "Wrong-Password-123", now: at(1000) })).toEqual(INVALID);
      // A password longer than bcrypt's 72-byte limit is refused cleanly, never crashes or half-matches.
      expect(await attempt(deps, f.email, { password: PASSWORD + "x".repeat(100), now: at(2000) })).toEqual(INVALID);
    });
  });

  // -------------------------------------------------------------------------
  describe("failed logins all look the same", () => {
    it("wrong password, unknown email: identical answer, and the password check always runs", async () => {
      const f = await fixture();
      const wrong = stubDeps();
      const a = await attempt(wrong.deps, f.email, { password: "Wrong-Password-1" });
      expect(a).toEqual(INVALID);
      expect(wrong.calls).toEqual([{ plain: "Wrong-Password-1" }]);
      expect(await attemptRows(f.email)).toHaveLength(1);
      expect((await attemptRows(f.email))[0].succeeded).toBe(false);

      const unknown = stubDeps();
      const ghost = track(`nobody-${randomBytes(5).toString("hex")}@example.test`);
      const b = await attempt(unknown.deps, ghost);
      expect(b).toEqual(a); // exactly the same answer
      expect(unknown.calls).toEqual([{ plain: PASSWORD }]); // still did a full check, on a throw-away hash
      expect(await attemptRows(ghost)).toHaveLength(1); // unknown emails are tracked too
    });
    it("a disabled account fails even with the right password, and its real hash is never used", async () => {
      const f = await fixture({ status: "DISABLED" });
      const { deps, calls } = stubDeps();
      expect(await attempt(deps, f.email)).toEqual(INVALID);
      expect(calls).toEqual([{ plain: PASSWORD }]);
      expect(await owner.session.count({ where: { userId: f.user.id } })).toBe(0);
    });
    it("an account with no password set fails", async () => {
      const f = await fixture({ passwordHash: null });
      const { deps, calls } = stubDeps();
      expect(await attempt(deps, f.email)).toEqual(INVALID);
      expect(calls).toEqual([{ plain: PASSWORD }]);
    });
    it("a correct password is still refused when the person has no usable workspace", async () => {
      const scenarios: [string, (userId: string, tag: string) => Promise<void>][] = [
        ["no membership at all", async () => {}],
        ["invitation not yet accepted", async (u, tag) => void (await makeMember((await makeOrg(u, tag)).id, u, "INVITED"))],
        ["membership suspended", async (u, tag) => void (await makeMember((await makeOrg(u, tag)).id, u, "SUSPENDED"))],
        ["organization suspended", async (u, tag) => void (await makeMember((await makeOrg(u, tag, "SUSPENDED")).id, u, "ACTIVE"))],
      ];
      for (const [label, setup] of scenarios) {
        const u = await makeUser();
        await setup(u.user.id, u.tag);
        expect(await attempt(stubDeps().deps, u.email), label).toEqual(INVALID);
        expect(await owner.session.count({ where: { userId: u.user.id } }), label).toBe(0);
        expect((await owner.user.findUniqueOrThrow({ where: { id: u.user.id } })).lastLoginAt, label).toBeNull();
      }
    });
    it("picks the oldest ACTIVE membership in an ACTIVE organization as the workspace", async () => {
      const u = await makeUser();
      const suspendedOrg = await makeOrg(u.user.id, u.tag, "SUSPENDED");
      const orgB = await makeOrg(u.user.id, u.tag);
      const orgC = await makeOrg(u.user.id, u.tag);
      await makeMember(suspendedOrg.id, u.user.id, "ACTIVE", at(-30 * DAY)); // oldest, but its organization is suspended
      await makeMember(orgC.id, u.user.id, "ACTIVE", at(-10 * DAY)); // newer
      await makeMember(orgB.id, u.user.id, "ACTIVE", at(-20 * DAY)); // the oldest usable one
      const r = await attempt(stubDeps().deps, u.email);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.organization.id).toBe(orgB.id);
    });
  });

  // -------------------------------------------------------------------------
  describe("throttling", () => {
    it("locks after 5 failures, refuses a 6th even with the right password, and then lifts", async () => {
      const f = await fixture();
      const { deps, calls } = stubDeps();
      const ip = newIp();
      for (let i = 0; i < 5; i++) {
        expect(await attempt(deps, f.email, { password: "Wrong-Password-1", now: at(i * 1000), ipAddress: ip })).toEqual(INVALID);
      }
      expect(calls).toHaveLength(5);

      const locked = await attempt(deps, f.email, { now: at(5000), ipAddress: ip }); // RIGHT password
      expect(locked).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 895 }); // first failure leaves the window in 15 min - 5 s
      expect(calls).toHaveLength(5); // the password check was never run for the refused attempt
      expect(await owner.session.count({ where: { userId: f.user.id } })).toBe(0);

      // Refused attempts are not recorded, so they cannot extend the lock.
      await attempt(deps, f.email, { now: at(6000), ipAddress: ip });
      await attempt(deps, f.email, { now: at(7000), ipAddress: ip });
      expect(await attemptRows(f.email)).toHaveLength(5);

      // Still locked one second before the first failure leaves the 15-minute window...
      const stillLocked = await attempt(deps, f.email, { now: at(15 * MIN - 1000), ipAddress: ip });
      expect(stillLocked).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 1 });
      // ...and free one second after it has (only 4 failures are left in the window, so no lock).
      expect((await attempt(deps, f.email, { now: at(15 * MIN + 1000), ipAddress: ip })).ok).toBe(true);
    });
    it("treats an unknown email exactly like a real one (no hint that the account exists)", async () => {
      const ghost = track(`ghost-${randomBytes(5).toString("hex")}@example.test`);
      const { deps } = stubDeps();
      const ip = newIp();
      for (let i = 0; i < 5; i++) await attempt(deps, ghost, { now: at(i * 1000), ipAddress: ip });
      const r = await attempt(deps, ghost, { now: at(5000), ipAddress: ip });
      expect(r).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 895 });
    });
    it("a successful login resets that email's failure counter", async () => {
      const f = await fixture();
      const { deps } = stubDeps();
      const ip = newIp();
      for (let i = 0; i < 4; i++) await attempt(deps, f.email, { password: "Wrong-Password-1", now: at(i * 1000), ipAddress: ip });
      expect((await attempt(deps, f.email, { now: at(10_000), ipAddress: ip })).ok).toBe(true); // success
      for (let i = 0; i < 5; i++) {
        const r = await attempt(deps, f.email, { password: "Wrong-Password-1", now: at(20_000 + i * 1000), ipAddress: ip });
        expect(r).toEqual(INVALID); // five more failures are all processed normally...
      }
      const r = await attempt(deps, f.email, { now: at(30_000), ipAddress: ip });
      expect(r.ok === false && r.reason).toBe("throttled"); // ...and only then is it locked
    });
    it("one IP address that fails 20 times is locked out, even for a real account", async () => {
      const f = await fixture();
      const badIp = newIp();
      await owner.authLoginAttempt.createMany({
        data: Array.from({ length: 20 }, () => ({
          identifierHash: randomBytes(8).toString("hex"),
          ipAddress: badIp,
          succeeded: false,
          createdAt: at(-MIN),
        })),
      });
      const { deps, calls } = stubDeps();
      const blocked = await attempt(deps, f.email, { ipAddress: badIp });
      expect(blocked).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 14 * 60 });
      expect(calls).toHaveLength(0);
      // The same person from another address is fine.
      expect((await attempt(deps, f.email, { ipAddress: newIp() })).ok).toBe(true);
    });
    it("ignores the IP rule when the address is unknown (no trusted proxy configured)", async () => {
      const f = await fixture();
      const { deps } = stubDeps();
      for (let i = 0; i < 25; i++) {
        // 25 failures for different unknown emails, with no IP recorded: only the email rule applies.
        await attempt(deps, track(`spray-${i}-${randomBytes(4).toString("hex")}@example.test`), { ipAddress: null, now: at(i * 100) });
      }
      expect((await attempt(deps, f.email, { ipAddress: null, now: at(5000) })).ok).toBe(true);
    });
    it("simultaneous guesses cannot slip past the limit", async () => {
      const f = await fixture();
      const { deps, calls } = stubDeps();
      const ip = newIp();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => attempt(deps, f.email, { password: "Wrong-Password-1", ipAddress: ip })),
      );
      // At most 5 of the 12 reached the (slow) password check; the rest were refused up front.
      expect(calls.length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => !r.ok && r.reason === "invalid_credentials")).toHaveLength(calls.length);
      expect(results.filter((r) => !r.ok && r.reason === "throttled")).toHaveLength(12 - calls.length);
      // Only attempts that were really processed stay on record.
      expect(await attemptRows(f.email)).toHaveLength(calls.length);
    });
  });

  // -------------------------------------------------------------------------
  describe("all-or-nothing", () => {
    it("signs nobody in if the audit record cannot be written", async () => {
      const f = await fixture();
      const { deps } = stubDeps({
        writeAudit: async () => {
          throw new Error("audit write failed");
        },
      });
      await expect(attempt(deps, f.email)).rejects.toThrow("audit write failed");
      expect(await owner.session.count({ where: { userId: f.user.id } })).toBe(0);
      expect((await owner.user.findUniqueOrThrow({ where: { id: f.user.id } })).lastLoginAt).toBeNull();
      expect((await attemptRows(f.email))[0].succeeded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("audit log", () => {
    it("records a successful login (one fixed test user, so the permanent audit rows do not pile up users)", async () => {
      // The audit log cannot be deleted, so this user and organization are created once and re-used.
      const email = track("audit-fixture@example.test");
      let user = await owner.user.findUnique({ where: { email } });
      user ??= await owner.user.create({ data: { email, name: "Audit Fixture", passwordHash: FAKE_HASH } });
      // The fixed user may still carry a hash from an earlier run: make sure it is the one this run knows.
      await owner.user.update({ where: { id: user.id }, data: { passwordHash: FAKE_HASH } });
      let org = await owner.organization.findUnique({ where: { slug: "audit-fixture" } });
      org ??= await owner.organization.create({ data: { slug: "audit-fixture", name: "Audit Fixture", ownerUserId: user.id } });
      await owner.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: { status: "ACTIVE" },
        create: { organizationId: org.id, userId: user.id, status: "ACTIVE", joinedAt: t0 },
      });
      // (Not added to the clean-up lists on purpose: audit rows will point at this user and organization.)

      const ip = newIp();
      const real = stubDeps();
      const r = await loginWithPassword(
        db,
        { email, password: PASSWORD, ipAddress: ip, userAgent: "vitest", now: t0, timings, authSecret: SECRET },
        { signIn: real.deps.signIn, writeAudit },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const audit = await owner.auditLog.findFirst({ where: { entityId: r.sessionId } });
      expect(audit).not.toBeNull();
      expect(audit).toMatchObject({
        action: "auth.login_succeeded",
        entityType: "session",
        actorUserId: user.id,
        organizationId: org.id,
        ipAddress: ip,
        userAgent: "vitest",
      });
      expect(JSON.stringify(audit)).not.toContain(r.token);
      await owner.session.deleteMany({ where: { id: r.sessionId } });
    });
  });
});
