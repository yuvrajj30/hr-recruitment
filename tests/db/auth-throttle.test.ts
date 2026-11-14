// Tests login throttling against the DISPOSABLE test database only (names ending "_test").
// Every time rule uses a fake clock, so nothing waits. Each test uses its own random identifier
// and IP address, so tests (and other test files running at the same time) never affect each other.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discardAttempt,
  evaluateThrottle,
  markAttemptSucceeded,
  purgeOldLoginAttempts,
  recordAttemptStart,
} from "@/lib/auth/throttle";
import { createDb, type Db } from "@/lib/db";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const MIN = 60_000;
const t0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe.skipIf(!enabled)("login throttling (test database)", () => {
  let owner: Db;
  let db: Db;
  const hashes: string[] = [];
  const ips: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 3 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.authLoginAttempt.deleteMany({
        where: { OR: [{ identifierHash: { in: hashes } }, { ipAddress: { in: ips } }] },
      });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  const newHash = () => {
    const h = randomBytes(16).toString("hex");
    hashes.push(h);
    return h;
  };
  const newIp = () => {
    const r = () => randomBytes(1)[0];
    const ip = `10.${r()}.${r()}.${r()}`;
    ips.push(ip);
    return ip;
  };

  type Row = { identifierHash: string; ipAddress?: string | null; succeeded: boolean; at: Date };
  const seed = (rows: Row[]) =>
    db.authLoginAttempt.createMany({
      data: rows.map((r) => ({
        identifierHash: r.identifierHash,
        ipAddress: r.ipAddress ?? null,
        succeeded: r.succeeded,
        createdAt: r.at,
      })),
    });
  const failures = (identifierHash: string, offsetsMin: number[], ipAddress: string | null = null): Row[] =>
    offsetsMin.map((m) => ({ identifierHash, ipAddress, succeeded: false, at: at(m * MIN) }));

  // What the login does: write the attempt down, then ask whether it is allowed.
  // This is only a probe, so it removes its own row again and never disturbs the next probe.
  const decide = async (identifierHash: string, ipAddress: string | null, now: Date) => {
    const ownAttemptId = await recordAttemptStart(db, { identifierHash, ipAddress, now });
    const decision = await evaluateThrottle(db, { identifierHash, ipAddress, now, ownAttemptId });
    await discardAttempt(db, ownAttemptId);
    return decision;
  };

  describe("per email", () => {
    it("allows an email with no history", async () => {
      expect(await decide(newHash(), null, t0)).toEqual({ blocked: false });
    });
    it("allows the 5th failure but blocks after 5 failures in 15 minutes", async () => {
      const four = newHash();
      await seed(failures(four, [-14, -12, -10, -8]));
      expect(await decide(four, null, t0)).toEqual({ blocked: false });
      const five = newHash();
      await seed(failures(five, [-14, -12, -10, -8, -6]));
      expect((await decide(five, null, t0)).blocked).toBe(true);
    });
    it("tells how long until the oldest counted failure leaves the window", async () => {
      const h = newHash();
      await seed(failures(h, [-14, -12, -10, -8, -6]));
      // The oldest of the 5 failures is 14 minutes old, so it leaves the 15-minute window in 60 seconds.
      expect(await decide(h, null, t0)).toEqual({ blocked: true, retryAfterSeconds: 60 });
    });
    it("lifts by itself as failures age out (no permanent lock)", async () => {
      const h = newHash();
      await seed(failures(h, [-14, -12, -10, -8, -6]));
      expect((await decide(h, null, at(59_000))).blocked).toBe(true);
      expect(await decide(h, null, at(61_000))).toEqual({ blocked: false });
    });
    it("ignores failures older than 15 minutes, including exactly 15 minutes", async () => {
      const old = newHash();
      await seed(failures(old, [-16, -17, -18, -19, -20]));
      expect(await decide(old, null, t0)).toEqual({ blocked: false });
      const edge = newHash();
      await seed(failures(edge, [-15, -14, -12, -10, -8])); // the -15 one is exactly on the edge: not counted
      expect(await decide(edge, null, t0)).toEqual({ blocked: false });
    });
    it("a successful login resets that email's counter", async () => {
      const h = newHash();
      await seed([
        ...failures(h, [-10, -9, -8, -7, -6]),
        { identifierHash: h, succeeded: true, at: at(-5 * MIN) },
        ...failures(h, [-4, -3, -2, -1]),
      ]);
      expect(await decide(h, null, t0)).toEqual({ blocked: false }); // only 4 failures since the success
      await seed(failures(h, [-0.5]));
      expect((await decide(h, null, t0)).blocked).toBe(true); // now 5 since the success
    });
    it("different emails do not affect each other", async () => {
      const a = newHash();
      const b = newHash();
      await seed(failures(a, [-5, -4, -3, -2, -1]));
      expect((await decide(a, null, t0)).blocked).toBe(true);
      expect(await decide(b, null, t0)).toEqual({ blocked: false });
    });
    it("never counts the attempt being decided against itself", async () => {
      const h = newHash();
      await seed(failures(h, [-4, -3, -2, -1])); // 4 on record
      const id = await recordAttemptStart(db, { identifierHash: h, ipAddress: null, now: t0 });
      expect(await evaluateThrottle(db, { identifierHash: h, ipAddress: null, now: t0, ownAttemptId: id })).toEqual({
        blocked: false,
      });
    });
  });

  describe("per IP address", () => {
    it("blocks after 20 failures from one address, whatever emails were tried", async () => {
      const ip = newIp();
      await seed(Array.from({ length: 19 }, () => ({ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: false, at: at(-MIN) })));
      expect(await decide(newHash(), ip, t0)).toEqual({ blocked: false });
      await seed([{ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: false, at: at(-MIN) }]);
      // 19 + 1 = 20 other failures now; they all leave the window 14 minutes from now.
      expect(await decide(newHash(), ip, t0)).toEqual({ blocked: true, retryAfterSeconds: 14 * 60 });
    });
    it("a success does NOT reset the IP counter", async () => {
      const ip = newIp();
      await seed(Array.from({ length: 20 }, () => ({ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: false, at: at(-3 * MIN) })));
      await seed([{ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: true, at: at(-2 * MIN) }]);
      expect((await decide(newHash(), ip, t0)).blocked).toBe(true);
    });
    it("does not block other addresses", async () => {
      const bad = newIp();
      await seed(Array.from({ length: 20 }, () => ({ identifierHash: randomBytes(8).toString("hex"), ipAddress: bad, succeeded: false, at: at(-MIN) })));
      expect(await decide(newHash(), newIp(), t0)).toEqual({ blocked: false });
    });
    it("ignores the IP rule completely when the address is unknown", async () => {
      const ip = newIp();
      await seed(Array.from({ length: 25 }, () => ({ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: false, at: at(-MIN) })));
      expect(await decide(newHash(), null, t0)).toEqual({ blocked: false });
    });
    it("uses the longer wait when both rules apply", async () => {
      const ip = newIp();
      const h = newHash();
      await seed(failures(h, [-14, -12, -10, -8, -6])); // email lock lifts in 60 s
      await seed(Array.from({ length: 20 }, () => ({ identifierHash: randomBytes(8).toString("hex"), ipAddress: ip, succeeded: false, at: at(-MIN) }))); // IP lock lifts in 840 s
      expect(await decide(h, ip, t0)).toEqual({ blocked: true, retryAfterSeconds: 840 });
    });
  });

  describe("recording attempts", () => {
    it("can mark an attempt successful, or remove it", async () => {
      const h = newHash();
      const id = await recordAttemptStart(db, { identifierHash: h, ipAddress: null, now: t0 });
      expect((await owner.authLoginAttempt.findUniqueOrThrow({ where: { id } })).succeeded).toBe(false);
      await markAttemptSucceeded(db, id);
      expect((await owner.authLoginAttempt.findUniqueOrThrow({ where: { id } })).succeeded).toBe(true);
      await discardAttempt(db, id);
      expect(await owner.authLoginAttempt.findUnique({ where: { id } })).toBeNull();
      await discardAttempt(db, id); // removing it again is harmless
    });
    it("keeps an over-long address within the column limit", async () => {
      const id = await recordAttemptStart(db, { identifierHash: newHash(), ipAddress: "9".repeat(300), now: t0 });
      const row = await owner.authLoginAttempt.findUniqueOrThrow({ where: { id } });
      expect(row.ipAddress!.length).toBeLessThanOrEqual(64);
    });
  });

  describe("housekeeping", () => {
    it("deletes records older than the retention period and keeps newer ones", async () => {
      // Dates in 2020 so this can only ever touch rows made by THIS test.
      const base = new Date("2020-02-01T00:00:00.000Z");
      const day = 86_400_000;
      const h = newHash();
      await seed([
        { identifierHash: h, succeeded: false, at: new Date(base.getTime()) }, // 24 days old at purge time
        { identifierHash: h, succeeded: false, at: new Date(base.getTime() + 5 * day) }, // 19 days old
        { identifierHash: h, succeeded: false, at: new Date(base.getTime() + 15 * day) }, // 9 days old
      ]);
      const now = new Date(base.getTime() + 24 * day);
      expect(await purgeOldLoginAttempts(db, now, 14)).toBeGreaterThanOrEqual(2);
      const left = await owner.authLoginAttempt.findMany({ where: { identifierHash: h } });
      expect(left).toHaveLength(1);
      expect(left[0].createdAt.getTime()).toBe(base.getTime() + 15 * day);
    });
  });
});
