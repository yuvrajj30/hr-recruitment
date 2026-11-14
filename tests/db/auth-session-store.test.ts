// Tests the session store against the DISPOSABLE test database only.
//   - the app code runs through the restricted hr_runtime account (TEST_RUNTIME_URL),
//   - test data is created and removed with the owner account (TEST_OWNER_URL).
// Both addresses must point at a database whose name ends in "_test", or the whole file is skipped.
// A fake clock is used for every time-based rule, so nothing here has to wait.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionTimings } from "@/lib/auth/config";
import {
  createSession,
  purgeEndedSessions,
  revokeAllSessionsForUser,
  revokeSessionByToken,
  revokeSessionsForMembership,
  validateSession,
} from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import { generateSessionToken, hashToken } from "@/lib/security/tokens";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const timings = sessionTimings({
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_HOURS: 12,
  SESSION_TOUCH_INTERVAL_SECONDS: 60,
});

describe.skipIf(!enabled)("session store (test database)", () => {
  let owner: Db; // creates and removes test data
  let db: Db; // what the app uses (hr_runtime)
  const userIds: string[] = [];
  const orgIds: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
  });

  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  // A fresh user + organization + active membership for each test, so tests never interfere.
  async function fixture() {
    const tag = randomBytes(5).toString("hex");
    const user = await owner.user.create({
      data: { email: `session-test-${tag}@example.test`, name: "Session Test" },
    });
    userIds.push(user.id);
    const org = await owner.organization.create({
      data: { slug: `t-${tag}`, name: `Test Org ${tag}`, ownerUserId: user.id },
    });
    orgIds.push(org.id);
    const member = await owner.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, status: "ACTIVE", joinedAt: t0 },
    });
    return { user, org, member };
  }

  const login = (f: Awaited<ReturnType<typeof fixture>>, now = t0, t = timings) =>
    createSession(db, {
      userId: f.user.id,
      activeOrganizationId: f.org.id,
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
      now,
      timings: t,
    });

  const check = (token: string | null, now: Date, touch = false, t = timings) =>
    validateSession(db, token, { now, timings: t, touch });

  const rowOf = (token: string) => owner.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });

  // -------------------------------------------------------------------------
  describe("creating a session", () => {
    it("stores only the hash of the token, never the token itself", async () => {
      const f = await fixture();
      const s = await login(f);
      expect(s.token).toHaveLength(43);
      const row = await rowOf(s.token);
      expect(row.tokenHash).toBe(hashToken(s.token));
      expect(row.tokenHash).not.toBe(s.token);
      expect(JSON.stringify(row)).not.toContain(s.token);
      const plain = await owner.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM sessions WHERE token_hash = ${s.token}`;
      expect(plain[0].n).toBe(0);
    });
    it("sets idle = +60 min and hard = +12 h from one clock reading", async () => {
      const s = await login(await fixture());
      expect(s.expiresAt).toEqual(at(60 * MIN));
      expect(s.absoluteExpiresAt).toEqual(at(12 * HOUR));
      const row = await rowOf(s.token);
      expect(row.expiresAt).toEqual(s.expiresAt);
      expect(row.absoluteExpiresAt).toEqual(s.absoluteExpiresAt);
      expect(row.lastSeenAt).toEqual(t0);
      expect(row.revokedAt).toBeNull();
    });
    it("gives every login a brand-new token", async () => {
      const f = await fixture();
      const a = await login(f);
      const b = await login(f);
      expect(a.token).not.toBe(b.token);
      expect(a.sessionId).not.toBe(b.sessionId);
    });
    it("keeps over-long address and browser text within limits", async () => {
      const f = await fixture();
      const s = await createSession(db, {
        userId: f.user.id,
        activeOrganizationId: f.org.id,
        ipAddress: "9".repeat(500),
        userAgent: "x".repeat(5000),
        now: t0,
        timings,
      });
      const row = await rowOf(s.token);
      expect(row.ipAddress!.length).toBeLessThanOrEqual(64);
      expect(row.userAgent!.length).toBeLessThanOrEqual(512);
    });
    it("is refused by the database if the idle deadline is later than the hard deadline", async () => {
      const f = await fixture();
      await expect(
        db.session.create({
          data: {
            userId: f.user.id,
            tokenHash: hashToken(generateSessionToken()),
            expiresAt: at(2 * HOUR),
            absoluteExpiresAt: at(1 * HOUR),
          },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe("validating a session", () => {
    it("accepts a good session and returns who it belongs to", async () => {
      const f = await fixture();
      const s = await login(f);
      const r = await check(s.token, at(5 * MIN));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.principal.sessionId).toBe(s.sessionId);
      expect(r.principal.user).toEqual({
        id: f.user.id,
        email: f.user.email,
        name: "Session Test",
        isPlatformAdmin: false,
      });
      expect(r.principal.organization).toEqual({ id: f.org.id, name: f.org.name, slug: f.org.slug });
      expect(r.principal.memberId).toBe(f.member.id);
    });
    it("rejects missing and badly shaped tokens without needing the database", async () => {
      for (const bad of [null, undefined, "", "abc", "a".repeat(44), `${generateSessionToken().slice(0, 42)}!`]) {
        expect(await check(bad as string | null, t0)).toEqual({ ok: false, reason: "malformed" });
      }
    });
    it("rejects a well-formed token that was never issued", async () => {
      expect(await check(generateSessionToken(), t0)).toEqual({ ok: false, reason: "not_found" });
    });
    it("rejects after the idle deadline (and exactly at it)", async () => {
      const s = await login(await fixture());
      expect((await check(s.token, at(60 * MIN - 1))).ok).toBe(true);
      expect(await check(s.token, at(60 * MIN))).toEqual({ ok: false, reason: "expired" });
      expect(await check(s.token, at(61 * MIN))).toEqual({ ok: false, reason: "expired" });
    });
    it("rejects after the hard deadline", async () => {
      const s = await login(await fixture());
      expect(await check(s.token, at(13 * HOUR))).toEqual({ ok: false, reason: "expired" });
    });
    it("rejects a revoked session", async () => {
      const s = await login(await fixture());
      await owner.session.update({ where: { id: s.sessionId }, data: { revokedAt: at(MIN), revokedReason: "x" } });
      expect(await check(s.token, at(2 * MIN))).toEqual({ ok: false, reason: "revoked" });
    });
    it("rejects at once when the user is disabled", async () => {
      const f = await fixture();
      const s = await login(f);
      await owner.user.update({ where: { id: f.user.id }, data: { status: "DISABLED" } });
      expect(await check(s.token, at(MIN))).toEqual({ ok: false, reason: "user_inactive" });
    });
    it("rejects at once when the organization is suspended", async () => {
      const f = await fixture();
      const s = await login(f);
      await owner.organization.update({ where: { id: f.org.id }, data: { status: "SUSPENDED" } });
      expect(await check(s.token, at(MIN))).toEqual({ ok: false, reason: "organization_inactive" });
    });
    it("rejects at once when the membership is suspended or was never accepted", async () => {
      const f = await fixture();
      const s = await login(f);
      await owner.organizationMember.update({ where: { id: f.member.id }, data: { status: "SUSPENDED" } });
      expect(await check(s.token, at(MIN))).toEqual({ ok: false, reason: "membership_inactive" });
      await owner.organizationMember.update({ where: { id: f.member.id }, data: { status: "INVITED" } });
      expect(await check(s.token, at(MIN))).toEqual({ ok: false, reason: "membership_inactive" });
    });
    it("rejects when the membership row is gone", async () => {
      const f = await fixture();
      const s = await login(f);
      await owner.organizationMember.delete({ where: { id: f.member.id } });
      expect(await check(s.token, at(MIN))).toEqual({ ok: false, reason: "membership_inactive" });
    });
    it("accepts again after a suspended membership is reactivated", async () => {
      const f = await fixture();
      const s = await login(f);
      await owner.organizationMember.update({ where: { id: f.member.id }, data: { status: "SUSPENDED" } });
      expect((await check(s.token, at(MIN))).ok).toBe(false);
      await owner.organizationMember.update({ where: { id: f.member.id }, data: { status: "ACTIVE" } });
      expect((await check(s.token, at(2 * MIN))).ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("sliding the idle deadline", () => {
    it("does not write before the touch interval has passed", async () => {
      const s = await login(await fixture());
      const r = await check(s.token, at(30_000), true);
      expect(r.ok).toBe(true);
      const row = await rowOf(s.token);
      expect(row.lastSeenAt).toEqual(t0);
      expect(row.expiresAt).toEqual(at(60 * MIN));
    });
    it("writes last-seen and moves the idle deadline once the interval has passed", async () => {
      const s = await login(await fixture());
      const r = await check(s.token, at(61_000), true);
      expect(r.ok).toBe(true);
      const row = await rowOf(s.token);
      expect(row.lastSeenAt).toEqual(at(61_000));
      expect(row.expiresAt).toEqual(at(61_000 + 60 * MIN));
      expect(row.absoluteExpiresAt).toEqual(at(12 * HOUR));
      if (r.ok) expect(r.principal.expiresAt).toEqual(at(61_000 + 60 * MIN));
    });
    it("does nothing when touching is switched off (the 'who am I' check)", async () => {
      const s = await login(await fixture());
      expect((await check(s.token, at(10 * MIN), false)).ok).toBe(true);
      const row = await rowOf(s.token);
      expect(row.lastSeenAt).toEqual(t0);
      expect(row.expiresAt).toEqual(at(60 * MIN));
    });
    it("keeps a busy user signed in past the first idle window", async () => {
      const s = await login(await fixture());
      for (const minutes of [50, 100, 150]) {
        expect((await check(s.token, at(minutes * MIN), true)).ok).toBe(true);
      }
      expect((await check(s.token, at(190 * MIN), true)).ok).toBe(true);
    });
    it("never moves the idle deadline past the hard deadline", async () => {
      const short = sessionTimings({
        SESSION_IDLE_MINUTES: 60,
        SESSION_ABSOLUTE_HOURS: 2,
        SESSION_TOUCH_INTERVAL_SECONDS: 60,
      });
      const s = await login(await fixture(), t0, short);
      expect((await check(s.token, at(59 * MIN), true, short)).ok).toBe(true);
      expect((await check(s.token, at(118 * MIN), true, short)).ok).toBe(true);
      const row = await rowOf(s.token);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.absoluteExpiresAt.getTime());
      expect(row.expiresAt).toEqual(row.absoluteExpiresAt);
      expect(row.absoluteExpiresAt).toEqual(at(2 * HOUR));
      // ...and the hard deadline still ends the session no matter how active the user was.
      expect((await check(s.token, at(2 * HOUR), true, short)).ok).toBe(false);
    });
    it("never brings an expired session back to life", async () => {
      const s = await login(await fixture());
      expect(await check(s.token, at(61 * MIN), true)).toEqual({ ok: false, reason: "expired" });
      const row = await rowOf(s.token);
      expect(row.expiresAt).toEqual(at(60 * MIN));
      expect(row.lastSeenAt).toEqual(t0);
    });
    it("copes with two requests arriving at the same moment", async () => {
      const s = await login(await fixture());
      const [a, b] = await Promise.all([check(s.token, at(2 * MIN), true), check(s.token, at(2 * MIN), true)]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      const row = await rowOf(s.token);
      expect(row.lastSeenAt).toEqual(at(2 * MIN));
      expect(row.expiresAt).toEqual(at(2 * MIN + 60 * MIN));
    });
  });

  // -------------------------------------------------------------------------
  describe("revoking sessions", () => {
    it("ends one session by token, records why, and can be repeated safely", async () => {
      const f = await fixture();
      const s = await login(f);
      const first = await revokeSessionByToken(db, s.token, "logout", at(MIN));
      expect(first).toEqual({ revoked: true, userId: f.user.id, organizationId: f.org.id });
      const row = await rowOf(s.token);
      expect(row.revokedAt).toEqual(at(MIN));
      expect(row.revokedReason).toBe("logout");
      expect(await check(s.token, at(2 * MIN))).toEqual({ ok: false, reason: "revoked" });
      // Second logout with the same token: harmless, and the first reason and time are kept.
      expect(await revokeSessionByToken(db, s.token, "admin_revoked", at(9 * MIN))).toEqual({ revoked: false });
      const again = await rowOf(s.token);
      expect(again.revokedAt).toEqual(at(MIN));
      expect(again.revokedReason).toBe("logout");
    });
    it("ignores unknown or malformed tokens", async () => {
      expect(await revokeSessionByToken(db, generateSessionToken(), "logout", t0)).toEqual({ revoked: false });
      expect(await revokeSessionByToken(db, "nope", "logout", t0)).toEqual({ revoked: false });
      expect(await revokeSessionByToken(db, null, "logout", t0)).toEqual({ revoked: false });
    });
    it("ends all of one user's sessions and nobody else's", async () => {
      const f = await fixture();
      const other = await fixture();
      const mine = [await login(f), await login(f), await login(f)];
      const theirs = await login(other);
      expect(await revokeAllSessionsForUser(db, f.user.id, "logout_all", at(MIN))).toBe(3);
      for (const s of mine) expect(await check(s.token, at(2 * MIN))).toEqual({ ok: false, reason: "revoked" });
      expect((await check(theirs.token, at(2 * MIN))).ok).toBe(true);
      // Nothing left to end, so nothing is counted again.
      expect(await revokeAllSessionsForUser(db, f.user.id, "logout_all", at(3 * MIN))).toBe(0);
    });
    it("can keep the current session when ending all the others", async () => {
      const f = await fixture();
      const keep = await login(f);
      const drop = await login(f);
      expect(
        await revokeAllSessionsForUser(db, f.user.id, "password_changed", at(MIN), { exceptSessionId: keep.sessionId }),
      ).toBe(1);
      expect((await check(keep.token, at(2 * MIN))).ok).toBe(true);
      expect((await check(drop.token, at(2 * MIN))).ok).toBe(false);
    });
    it("does not overwrite the reason of a session that already ended", async () => {
      const f = await fixture();
      const s = await login(f);
      await revokeSessionByToken(db, s.token, "logout", at(MIN));
      await revokeAllSessionsForUser(db, f.user.id, "user_disabled", at(5 * MIN));
      const row = await rowOf(s.token);
      expect(row.revokedReason).toBe("logout");
      expect(row.revokedAt).toEqual(at(MIN));
    });
    it("ends only the sessions working inside the organization whose membership changed", async () => {
      const f = await fixture();
      const orgB = await owner.organization.create({
        data: { slug: `t-b-${randomBytes(4).toString("hex")}`, name: "Org B", ownerUserId: f.user.id },
      });
      orgIds.push(orgB.id);
      await owner.organizationMember.create({
        data: { organizationId: orgB.id, userId: f.user.id, status: "ACTIVE", joinedAt: t0 },
      });
      const inA = await login(f);
      const inB = await createSession(db, {
        userId: f.user.id,
        activeOrganizationId: orgB.id,
        ipAddress: null,
        userAgent: null,
        now: t0,
        timings,
      });
      expect(await revokeSessionsForMembership(db, f.org.id, f.user.id, "membership_changed", at(MIN))).toBe(1);
      expect((await check(inA.token, at(2 * MIN))).ok).toBe(false);
      expect((await check(inB.token, at(2 * MIN))).ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("cleaning up old sessions", () => {
    it("deletes sessions that ended long ago and keeps everything else", async () => {
      // Uses dates in 2020 so the clean-up can only ever touch rows made by THIS test,
      // never rows that other test files (running at the same time) created.
      const base = new Date("2020-03-01T10:00:00.000Z");
      const when = (ms: number) => new Date(base.getTime() + ms);
      const f = await fixture();
      const old = await login(f, base); // idle and hard deadlines passed ~40 days before the purge
      const nowPurge = when(40 * DAY + HOUR);
      const active = await login(f, when(40 * DAY)); // still usable at purge time
      const recentlyRevoked = await login(f, when(39 * DAY));
      await owner.session.update({ where: { id: recentlyRevoked.sessionId }, data: { revokedAt: when(39 * DAY + MIN) } });
      const longRevoked = await login(f, when(35 * DAY));
      await owner.session.update({ where: { id: longRevoked.sessionId }, data: { revokedAt: when(1 * DAY) } });

      const deleted = await purgeEndedSessions(db, nowPurge, 30);
      expect(deleted).toBeGreaterThanOrEqual(2);

      const left = await owner.session.findMany({
        where: { id: { in: [old.sessionId, active.sessionId, recentlyRevoked.sessionId, longRevoked.sessionId] } },
        select: { id: true },
      });
      const ids = left.map((r) => r.id).sort();
      expect(ids).toEqual([active.sessionId, recentlyRevoked.sessionId].sort());
    });
  });
});
