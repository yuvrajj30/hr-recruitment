// Tests the five auth endpoints as the browser would reach them: a Request goes in, a Response comes out.
// Runs against the DISPOSABLE test database only (names ending "_test"), with a fake clock, a stand-in
// password check, and a recorder instead of the real audit writer (real audit rows can never be deleted).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import { getAuthContext } from "@/lib/auth/context";
import {
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleSession,
  handleSwitchOrganization,
} from "@/lib/auth/handlers";
import type { AuthRuntime } from "@/lib/auth/runtime";
import { createSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { guarded } from "@/lib/http/handler";
import { hashIdentifier } from "@/lib/security/tokens";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const MIN = 60_000;
const ORIGIN = "http://localhost:3000";
const t0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const SECRET = "route-test-secret-".repeat(3);
const PASSWORD = "Correct-Horse-Battery-9";
const FAKE_HASH = `fake:${PASSWORD}`;
const rnd = () => randomBytes(4).toString("hex");

describe.skipIf(!enabled)("auth endpoints (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  const roleIds: string[] = [];
  const permissionIds: string[] = [];
  const hashes: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.authLoginAttempt.deleteMany({ where: { identifierHash: { in: hashes } } });
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.role.deleteMany({ where: { id: { in: roleIds } } });
      await owner.permission.deleteMany({ where: { id: { in: permissionIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  // ----- test plumbing ------------------------------------------------------
  function makeRuntime(over: Partial<AuthRuntime> = {}) {
    const audits: AuditEntry[] = [];
    const tasks: (() => Promise<void>)[] = [];
    const calls: { plain: string; hash: string | null }[] = [];
    const clock = { now: t0 };
    const rt: AuthRuntime = {
      db,
      appOrigin: ORIGIN,
      authSecret: SECRET,
      timings,
      trustedProxyHops: 0,
      clientIpHeader: "x-forwarded-for",
      retention: { loginAttemptDays: 14, sessionDays: 30 },
      now: () => clock.now,
      deps: {
        verifyPassword: async (plain, hash) => {
          calls.push({ plain, hash });
          return hash !== null && hash === `fake:${plain}`;
        },
        writeAudit: async (_db, entry) => void audits.push(entry),
      },
      runLater: (task) => void tasks.push(task),
      shouldRunCleanup: () => false,
      ...over,
    };
    return { rt, audits, tasks, calls, clock };
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { method: "GET", headers });
  const cookieHeader = (token: string, name = "hr_session") => ({ cookie: `${name}=${token}` });
  const tokenFrom = (res: Response, name = "hr_session") => {
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return header ? header.slice(name.length + 1).split(";")[0]! : null;
  };
  const json = async (res: Response) => JSON.parse(await res.text());

  async function makeRole(permissionKeys: string[]) {
    const role = await owner.role.create({ data: { key: `T_RT_${rnd()}`, name: "Route Test", isSystem: false } });
    roleIds.push(role.id);
    for (const key of permissionKeys) {
      const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, module: "test" } });
      if (!permissionIds.includes(p.id)) permissionIds.push(p.id);
      await owner.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    return role;
  }
  async function makeUser() {
    const email = `route-test-${rnd()}${rnd()}@example.test`;
    hashes.push(hashIdentifier(email, SECRET));
    const user = await owner.user.create({ data: { email, name: "Route Test", passwordHash: FAKE_HASH } });
    userIds.push(user.id);
    return user;
  }
  async function makeOrg(ownerUserId: string) {
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: `Org ${rnd()}`, ownerUserId } });
    orgIds.push(org.id);
    return org;
  }
  const makeMember = (organizationId: string, userId: string, roleId?: string) =>
    owner.organizationMember.create({
      data: { organizationId, userId, status: "ACTIVE", joinedAt: t0, ...(roleId ? { roles: { create: [{ roleId }] } } : {}) },
    });
  async function fixture(permissionKeys: string[] = []) {
    const user = await makeUser();
    const org = await makeOrg(user.id);
    const role = permissionKeys.length ? await makeRole(permissionKeys) : undefined;
    await makeMember(org.id, user.id, role?.id);
    return { user, org, email: user.email };
  }
  const signIn = (userId: string, organizationId: string | null) =>
    createSession(db, { userId, activeOrganizationId: organizationId, ipAddress: null, userAgent: null, now: t0, timings });
  const isValid = async (token: string, now = at(MIN)) =>
    (await getAuthContext(db, token, { now, timings, touch: false })).ok;
  const attemptCount = (email: string) =>
    owner.authLoginAttempt.count({ where: { identifierHash: hashIdentifier(email, SECRET) } });

  // =========================================================================
  describe("POST /api/auth/login", () => {
    it("signs in: safe headers, a correct cookie, and a body without any secrets", async () => {
      const f = await fixture();
      const { rt } = makeRuntime();
      const res = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }), rt);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")).toContain("application/json");

      const text = await res.text();
      const body = JSON.parse(text);
      expect(Object.keys(body).sort()).toEqual(["organization", "redirectTo", "user"]);
      expect(body.user).toEqual({ id: f.user.id, email: f.email, name: "Route Test" });
      expect(body.organization).toMatchObject({ id: f.org.id, slug: f.org.slug });
      expect(body.redirectTo).toBe("/dashboard");

      const cookies = res.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      const [cookie] = cookies;
      const token = tokenFrom(res)!;
      expect(token).toHaveLength(43);
      for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=43200"]) expect(cookie).toContain(flag);
      expect(cookie).not.toContain("Secure"); // plain http in local development
      expect(cookie.toLowerCase()).not.toContain("domain=");
      // Nothing secret is ever in the body.
      for (const secret of [token, "passwordHash", "fake:", PASSWORD]) expect(text).not.toContain(secret);
      // And the cookie really is a working session.
      expect(await isValid(token)).toBe(true);
    });
    it("on https the cookie gets the __Host- name and the Secure flag", async () => {
      const f = await fixture();
      const https = "https://hr.example.com";
      const { rt } = makeRuntime({ appOrigin: https });
      const res = await handleLogin(
        new Request(`${https}/api/auth/login`, {
          method: "POST",
          headers: { origin: https, "content-type": "application/json" },
          body: JSON.stringify({ email: f.email, password: PASSWORD }),
        }),
        rt,
      );
      expect(res.status).toBe(200);
      const [cookie] = res.headers.getSetCookie();
      expect(cookie.startsWith("__Host-hr_session=")).toBe(true);
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
    });
    it("sends the person to a safe 'next' page, and ignores unsafe ones", async () => {
      const f = await fixture();
      const { rt, clock } = makeRuntime();
      const where = async (next: unknown) => {
        clock.now = at(clock.now.getTime() - t0.getTime() + 1000); // move the clock so earlier logins never matter
        const res = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD, next }), rt);
        return (await json(res)).redirectTo;
      };
      expect(await where("/jobs?status=open")).toBe("/jobs?status=open");
      for (const unsafe of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "/login", "/api/auth/logout"]) {
        expect(await where(unsafe), unsafe).toBe("/dashboard");
      }
    });
    it("answers wrong password and unknown email with exactly the same 401 and no cookie", async () => {
      const f = await fixture();
      const { rt } = makeRuntime();
      const wrong = await handleLogin(post("/api/auth/login", { email: f.email, password: "Wrong-Password-1" }), rt);
      const ghostEmail = `ghost-${rnd()}@example.test`;
      hashes.push(hashIdentifier(ghostEmail, SECRET));
      const ghost = await handleLogin(post("/api/auth/login", { email: ghostEmail, password: PASSWORD }), rt);
      for (const res of [wrong, ghost]) {
        expect(res.status).toBe(401);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      expect(await wrong.text()).toBe('{"error":"invalid_credentials"}');
      expect(await ghost.text()).toBe('{"error":"invalid_credentials"}');
    });
    it("answers 429 with Retry-After once the limit is reached, and never sets a cookie", async () => {
      const f = await fixture();
      const { rt, clock, calls } = makeRuntime();
      for (let i = 0; i < 5; i++) {
        clock.now = at(i * 1000);
        expect((await handleLogin(post("/api/auth/login", { email: f.email, password: "Wrong-Password-1" }), rt)).status).toBe(401);
      }
      clock.now = at(5000);
      const res = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }), rt); // right password
      expect(res.status).toBe(429);
      const body = await json(res);
      expect(body).toEqual({ error: "too_many_attempts", retryAfterSeconds: 895 });
      expect(res.headers.get("retry-after")).toBe("895");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(calls).toHaveLength(5); // the password check never ran for the refused attempt
    });
    it("refuses requests that do not come from our own pages, before doing any work", async () => {
      const f = await fixture();
      const { rt, calls } = makeRuntime();
      const payload = JSON.stringify({ email: f.email, password: PASSWORD });
      const base = { "content-type": "application/json" };
      const attempts: Request[] = [
        new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: base, body: payload }), // no origin information at all
        new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { ...base, origin: "https://evil.example" }, body: payload }),
        new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { ...base, origin: "null" }, body: payload }),
        new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { ...base, "sec-fetch-site": "cross-site" }, body: payload }),
      ];
      for (const req of attempts) {
        const res = await handleLogin(req, rt);
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('{"error":"forbidden"}');
        expect(res.headers.getSetCookie()).toEqual([]);
      }
      expect(calls).toHaveLength(0);
      expect(await attemptCount(f.email)).toBe(0); // not even recorded as an attempt
    });
    it("refuses the wrong content type (415), oversized bodies (413) and malformed requests (400)", async () => {
      const f = await fixture();
      const { rt, calls } = makeRuntime();
      const good = { email: f.email, password: PASSWORD };
      const expectStatus = async (req: Request, status: number, error: string) => {
        const res = await handleLogin(req, rt);
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(JSON.stringify({ error }));
      };
      await expectStatus(post("/api/auth/login", JSON.stringify(good), { "content-type": "text/plain" }), 415, "unsupported_media_type");
      await expectStatus(post("/api/auth/login", "email=a&password=b", { "content-type": "application/x-www-form-urlencoded" }), 415, "unsupported_media_type");
      await expectStatus(post("/api/auth/login", good, { "content-length": "999999" }), 413, "payload_too_large");
      await expectStatus(post("/api/auth/login", { ...good, password: "x".repeat(5000) }), 413, "payload_too_large");
      for (const bad of [
        "{", "null", "[]", '"text"', "{}",
        { email: f.email },
        { password: PASSWORD },
        { email: 5, password: PASSWORD },
        { email: "not-an-email", password: PASSWORD },
        { ...good, isPlatformAdmin: true },
        { ...good, password: "" },
        { ...good, next: 5 },
      ]) {
        await expectStatus(post("/api/auth/login", bad), 400, "invalid_request");
      }
      expect(calls).toHaveLength(0); // none of these reached the password check
      expect(await attemptCount(f.email)).toBe(0);
    });
    it("hides unexpected failures: generic 500, and the log holds no secrets", async () => {
      const f = await fixture();
      const { rt } = makeRuntime({
        deps: {
          verifyPassword: async () => {
            throw new Error("boom: could not reach postgresql://app:SuperSecretPw@db.internal/hr");
          },
          writeAudit: async () => {},
        },
      });
      const written: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      let res: Response;
      try {
        res = await guarded("login", (r) => handleLogin(r, rt))(post("/api/auth/login", { email: f.email, password: PASSWORD }));
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe('{"error":"server_error"}');
      expect(text).not.toContain("SuperSecretPw");
      const log = written.join("");
      expect(log).toContain("auth.route_failed");
      expect(log).toContain('"route":"login"');
      expect(log).not.toContain("SuperSecretPw");
      expect(log).not.toContain(f.email);
      expect(log).not.toContain(PASSWORD);
    });
    it("logs a short error code (like a database error number) but never the error message", async () => {
      const f = await fixture();
      const failure = Object.assign(new Error("duplicate key value in table users for ana@example.com"), { code: "23505" });
      const { rt } = makeRuntime({
        deps: { verifyPassword: async () => { throw failure; }, writeAudit: async () => {} },
      });
      const written: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      try {
        await guarded("login", (r) => handleLogin(r, rt))(post("/api/auth/login", { email: f.email, password: PASSWORD }));
      } finally {
        spy.mockRestore();
      }
      const log = written.join("");
      expect(log).toContain('"failureKind":"23505"');
      expect(log).not.toContain("ana@example.com");
      expect(log).not.toContain("duplicate key");
    });
    it("explains a settings problem in the log (names only) while the browser still sees a plain 500", async () => {
      const failing = guarded("login", async () => {
        throw new EnvError("Invalid environment settings:\n  - APP_ORIGIN: must be an https:// address in production");
      });
      const written: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      let res: Response;
      try {
        res = await failing(post("/api/auth/login", {}));
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"server_error"}');
      expect(written.join("")).toContain("APP_ORIGIN: must be an https:// address in production");
    });
    it("ends an older session that the browser still held", async () => {
      const f = await fixture();
      const { rt, clock } = makeRuntime();
      const first = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }), rt);
      const tokenA = tokenFrom(first)!;
      clock.now = at(5000);
      const second = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }, cookieHeader(tokenA)), rt);
      const tokenB = tokenFrom(second)!;
      expect(tokenB).not.toBe(tokenA);
      expect(await isValid(tokenA, at(MIN))).toBe(false);
      expect(await isValid(tokenB, at(MIN))).toBe(true);
    });
    it("records the client address only when a trusted proxy is configured (forged headers are ignored)", async () => {
      const f = await fixture();
      const forged = { "x-forwarded-for": "9.9.9.9", "user-agent": "route-test-agent" };
      const direct = makeRuntime();
      const r1 = await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }, forged), direct.rt);
      const row1 = await owner.session.findFirstOrThrow({ where: { userId: f.user.id }, orderBy: { createdAt: "desc" } });
      expect(r1.status).toBe(200);
      expect(row1.ipAddress).toBeNull(); // header ignored: nobody is trusted to say where they come from
      expect(row1.userAgent).toBe("route-test-agent");

      const proxied = makeRuntime({ trustedProxyHops: 1 });
      proxied.clock.now = at(5000);
      await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }, forged), proxied.rt);
      const row2 = await owner.session.findFirstOrThrow({ where: { userId: f.user.id }, orderBy: { createdAt: "desc" } });
      expect(row2.ipAddress).toBe("9.9.9.9");
    });
    it("schedules housekeeping after a successful login only, and only when due", async () => {
      const f = await fixture();
      const never = makeRuntime();
      await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }), never.rt);
      expect(never.tasks).toHaveLength(0);

      const due = makeRuntime({ shouldRunCleanup: () => true });
      due.clock.now = at(5000);
      await handleLogin(post("/api/auth/login", { email: f.email, password: "Wrong-Password-1" }), due.rt);
      expect(due.tasks).toHaveLength(0); // a failed login schedules nothing
      due.clock.now = at(6000);
      await handleLogin(post("/api/auth/login", { email: f.email, password: PASSWORD }), due.rt);
      expect(due.tasks).toHaveLength(1);
    });
  });

  // =========================================================================
  describe("POST /api/auth/logout", () => {
    const cleared = (res: Response) => {
      const [c] = res.headers.getSetCookie();
      expect(res.headers.getSetCookie()).toHaveLength(1);
      for (const flag of ["hr_session=;", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "HttpOnly", "SameSite=Lax", "Path=/"]) {
        expect(c).toContain(flag);
      }
    };
    it("ends the session, clears the cookie and writes an audit record", async () => {
      const f = await fixture();
      const { rt, audits } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      const res = await handleLogout(post("/api/auth/logout", "", cookieHeader(s.token)), rt);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
      cleared(res);
      expect(await isValid(s.token)).toBe(false);
      const row = await owner.session.findUniqueOrThrow({ where: { id: s.sessionId } });
      expect(row.revokedReason).toBe("logout");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "auth.logout", actorUserId: f.user.id, organizationId: f.org.id });
    });
    it("can be repeated safely, and works when nobody is signed in", async () => {
      const f = await fixture();
      const { rt, audits } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      await handleLogout(post("/api/auth/logout", "", cookieHeader(s.token)), rt);
      for (const headers of [cookieHeader(s.token), {}, cookieHeader("garbage"), cookieHeader(randomBytes(32).toString("base64url"))]) {
        const res = await handleLogout(post("/api/auth/logout", "", headers), rt);
        expect(res.status).toBe(200);
        cleared(res);
      }
      expect(audits).toHaveLength(1); // only the real sign-out was recorded
    });
    it("cannot be triggered from another website", async () => {
      const f = await fixture();
      const { rt } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      const res = await handleLogout(post("/api/auth/logout", "", { ...cookieHeader(s.token), origin: "https://evil.example" }), rt);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await isValid(s.token)).toBe(true); // still signed in
    });
    it("still clears the cookie, but reports an error, if the database cannot be reached", async () => {
      const brokenDb = { session: { findUnique: async () => { throw new Error("db down"); } } } as unknown as Db;
      const { rt } = makeRuntime({ db: brokenDb });
      const res = await handleLogout(post("/api/auth/logout", "", cookieHeader(randomBytes(32).toString("base64url"))), rt);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"server_error"}');
      cleared(res);
    });
  });

  // =========================================================================
  describe("POST /api/auth/logout-all", () => {
    it("needs a session", async () => {
      const { rt } = makeRuntime();
      const none = await handleLogoutAll(post("/api/auth/logout-all", ""), rt);
      expect(none.status).toBe(401);
      expect(await none.text()).toBe('{"error":"unauthorized"}');
      expect(none.headers.getSetCookie()).toEqual([]); // no cookie was sent, so nothing to tidy
      const junk = await handleLogoutAll(post("/api/auth/logout-all", "", cookieHeader(randomBytes(32).toString("base64url"))), rt);
      expect(junk.status).toBe(401);
      expect(junk.headers.getSetCookie()[0]).toContain("Max-Age=0"); // a stale cookie is cleared away
    });
    it("ends every session of the person, and only theirs", async () => {
      const f = await fixture();
      const other = await fixture();
      const { rt, audits } = makeRuntime();
      const mine = [await signIn(f.user.id, f.org.id), await signIn(f.user.id, f.org.id), await signIn(f.user.id, f.org.id)];
      const theirs = await signIn(other.user.id, other.org.id);
      const res = await handleLogoutAll(post("/api/auth/logout-all", "", cookieHeader(mine[0].token)), rt);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true,"revokedSessions":3}');
      expect(res.headers.getSetCookie()[0]).toContain("Max-Age=0");
      for (const s of mine) expect(await isValid(s.token)).toBe(false);
      expect(await isValid(theirs.token)).toBe(true);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "auth.logout_all", actorUserId: f.user.id, metadata: { revokedSessions: 3 } });
    });
    it("cannot be triggered from another website", async () => {
      const f = await fixture();
      const { rt } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      const res = await handleLogoutAll(post("/api/auth/logout-all", "", { ...cookieHeader(s.token), origin: "https://evil.example" }), rt);
      expect(res.status).toBe(403);
      expect(await isValid(s.token)).toBe(true);
    });
    it("ends nothing if the audit record cannot be written", async () => {
      const f = await fixture();
      const { rt } = makeRuntime({
        deps: { verifyPassword: async () => false, writeAudit: async () => { throw new Error("audit write failed"); } },
      });
      const s = await signIn(f.user.id, f.org.id);
      const res = await guarded("logout-all", (r) => handleLogoutAll(r, rt))(post("/api/auth/logout-all", "", cookieHeader(s.token)));
      expect(res.status).toBe(500);
      expect(await isValid(s.token)).toBe(true); // rolled back: still signed in, and can try again
    });
  });

  // =========================================================================
  describe("GET /api/auth/session", () => {
    it("says 401 when nobody is signed in, and tidies a stale cookie", async () => {
      const { rt } = makeRuntime();
      const none = await handleSession(get("/api/auth/session"), rt);
      expect(none.status).toBe(401);
      expect(await none.text()).toBe('{"error":"unauthorized"}');
      expect(none.headers.getSetCookie()).toEqual([]);
      const stale = await handleSession(get("/api/auth/session", cookieHeader(randomBytes(32).toString("base64url"))), rt);
      expect(stale.status).toBe(401);
      expect(stale.headers.getSetCookie()[0]).toContain("Max-Age=0");
      const broken = await handleSession(get("/api/auth/session", cookieHeader("nonsense")), rt);
      expect(broken.headers.getSetCookie()[0]).toContain("Max-Age=0");
    });
    it("describes the signed-in person, their organization, roles and permissions", async () => {
      const tag = rnd();
      const f = await fixture([`trt${tag}:b_perm`, `trt${tag}:a_perm`]);
      const { rt } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      const res = await handleSession(get("/api/auth/session", cookieHeader(s.token)), rt);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text);
      expect(Object.keys(body).sort()).toEqual(["absoluteExpiresAt", "expiresAt", "organization", "permissions", "roles", "user"]);
      expect(body.user).toEqual({ id: f.user.id, email: f.email, name: "Route Test" });
      expect(body.organization).toMatchObject({ id: f.org.id, slug: f.org.slug });
      expect(body.permissions).toEqual([`trt${tag}:a_perm`, `trt${tag}:b_perm`]); // sorted
      expect(body.roles).toHaveLength(1);
      expect(body.expiresAt).toBe(at(60 * MIN).toISOString());
      expect(body.absoluteExpiresAt).toBe(at(12 * 60 * MIN).toISOString());
      for (const secret of [s.token, "passwordHash", "isPlatformAdmin", "fake:"]) expect(text).not.toContain(secret);
    });
    it("never moves the idle deadline, so polling cannot keep a session alive", async () => {
      const f = await fixture();
      const { rt, clock } = makeRuntime();
      const s = await signIn(f.user.id, f.org.id);
      clock.now = at(10 * MIN);
      expect((await handleSession(get("/api/auth/session", cookieHeader(s.token)), rt)).status).toBe(200);
      const row = await owner.session.findUniqueOrThrow({ where: { id: s.sessionId } });
      expect(row.lastSeenAt).toEqual(t0);
      expect(row.expiresAt).toEqual(at(60 * MIN));
    });
    it("says 401 for expired and revoked sessions", async () => {
      const f = await fixture();
      const { rt, clock } = makeRuntime();
      const expired = await signIn(f.user.id, f.org.id);
      clock.now = at(61 * MIN);
      expect((await handleSession(get("/api/auth/session", cookieHeader(expired.token)), rt)).status).toBe(401);
      clock.now = at(MIN);
      const revoked = await signIn(f.user.id, f.org.id);
      await owner.session.update({ where: { id: revoked.sessionId }, data: { revokedAt: at(0) } });
      expect((await handleSession(get("/api/auth/session", cookieHeader(revoked.token)), rt)).status).toBe(401);
    });
  });

  // =========================================================================
  describe("POST /api/auth/organization", () => {
    async function twoOrgs() {
      const tag = rnd();
      const roleA = await makeRole([`trt${tag}:only_a`]);
      const roleB = await makeRole([`trt${tag}:only_b`]);
      const me = await makeUser();
      const stranger = await makeUser();
      const orgA = await makeOrg(me.id);
      const orgB = await makeOrg(me.id);
      const foreign = await makeOrg(stranger.id);
      await makeMember(orgA.id, me.id, roleA.id);
      await makeMember(orgB.id, me.id, roleB.id);
      await makeMember(foreign.id, stranger.id);
      const session = await signIn(me.id, orgA.id);
      return { tag, me, orgA, orgB, foreign, session };
    }
    it("needs a session, and refuses other websites", async () => {
      const w = await twoOrgs();
      const { rt } = makeRuntime();
      const anon = await handleSwitchOrganization(post("/api/auth/organization", { organizationId: w.orgB.id }), rt);
      expect(anon.status).toBe(401);
      const cross = await handleSwitchOrganization(
        post("/api/auth/organization", { organizationId: w.orgB.id }, { ...cookieHeader(w.session.token), origin: "https://evil.example" }),
        rt,
      );
      expect(cross.status).toBe(403);
      expect(await isValid(w.session.token)).toBe(true);
    });
    it("rejects malformed requests", async () => {
      const w = await twoOrgs();
      const { rt } = makeRuntime();
      for (const bad of ["{", {}, { organizationId: "123" }, { organizationId: w.orgB.id, extra: 1 }]) {
        const res = await handleSwitchOrganization(post("/api/auth/organization", bad, cookieHeader(w.session.token)), rt);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('{"error":"invalid_request"}');
      }
      const wrongType = await handleSwitchOrganization(
        post("/api/auth/organization", { organizationId: w.orgB.id }, { ...cookieHeader(w.session.token), "content-type": "text/plain" }),
        rt,
      );
      expect(wrongType.status).toBe(415);
    });
    it("gives the same 403 for an organization that is not yours and one that does not exist", async () => {
      const w = await twoOrgs();
      const { rt, audits } = makeRuntime();
      const bodies: string[] = [];
      for (const organizationId of [w.foreign.id, randomUUID()]) {
        const res = await handleSwitchOrganization(post("/api/auth/organization", { organizationId }, cookieHeader(w.session.token)), rt);
        expect(res.status).toBe(403);
        bodies.push(await res.text());
      }
      expect(bodies[0]).toBe('{"error":"forbidden"}');
      expect(bodies[1]).toBe(bodies[0]);
      expect(audits).toHaveLength(0);
      const row = await owner.session.findUniqueOrThrow({ where: { id: w.session.sessionId } });
      expect(row.activeOrganizationId).toBe(w.orgA.id);
    });
    it("switches, and the next request shows only the new organization's permissions", async () => {
      const w = await twoOrgs();
      const { rt, audits } = makeRuntime();
      const before = await json(await handleSession(get("/api/auth/session", cookieHeader(w.session.token)), rt));
      expect(before.permissions).toEqual([`trt${w.tag}:only_a`]);

      const res = await handleSwitchOrganization(post("/api/auth/organization", { organizationId: w.orgB.id }, cookieHeader(w.session.token)), rt);
      expect(res.status).toBe(200);
      expect((await json(res)).organization).toMatchObject({ id: w.orgB.id, slug: w.orgB.slug });
      expect(res.headers.get("cache-control")).toBe("no-store");

      const after = await json(await handleSession(get("/api/auth/session", cookieHeader(w.session.token)), rt));
      expect(after.organization.id).toBe(w.orgB.id);
      expect(after.permissions).toEqual([`trt${w.tag}:only_b`]); // nothing carried over from organization A
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "auth.organization_switched", organizationId: w.orgB.id });
    });
  });
});
