// Self-service ("My account") against the DISPOSABLE test database. Audit writes go to a recorder.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/security/password";
import { changeMyPassword, getMyAccount, type SelfDeps, updateMyName } from "@/lib/users/self";
import { realRoleIds } from "./roles-helper";
import { bindSessionToken } from "@/lib/auth/session-binding";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const now = new Date();
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "self-test.example.test";
const OLD = "Old-Password-Brew-11";
const NEW = "New-Password-Grind-22";

describe.skipIf(!enabled)("self-service: my account (test database)", () => {
  let owner: Db;
  let db: Db;
  let role: Record<RoleKey, string>;
  const orgIds: string[] = [];

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
    role = await realRoleIds(owner);
  });
  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { user: { email: { endsWith: `@${DOMAIN}` } } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  async function world(key: RoleKey = "EMPLOYEE") {
    const admin = await owner.user.create({ data: { email: `admin-${rnd()}@${DOMAIN}`, name: "Admin" } });
    const me = await owner.user.create({ data: { email: `me-${rnd()}@${DOMAIN}`, name: "Meera Shah", passwordHash: await hashPassword(OLD) } });
    const other = await owner.user.create({ data: { email: `other-${rnd()}@${DOMAIN}`, name: "Other Person" } });
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: "Self Org", ownerUserId: admin.id } });
    orgIds.push(org.id);
    await owner.organizationMember.create({ data: { organizationId: org.id, userId: admin.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role.SUPER_ADMIN }] } } });
    const member = await owner.organizationMember.create({ data: { organizationId: org.id, userId: me.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role[key] }] } } });
    await owner.organizationMember.create({ data: { organizationId: org.id, userId: other.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role.EMPLOYEE }] } } });
    const current = await createSession(owner, { userId: me.id, activeOrganizationId: org.id, ipAddress: null, userAgent: null, now, timings });
    const elsewhere = await createSession(owner, { userId: me.id, activeOrganizationId: org.id, ipAddress: null, userAgent: null, now, timings });
    const ctx: AuthContext = {
      sessionId: current.sessionId,
      user: { id: me.id, email: me.email, name: me.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId: member.id, expiresAt: now, absoluteExpiresAt: now, roleKeys: [key], permissions: new Set(ROLE_PERMISSIONS[key]),
    };
    bindSessionToken(ctx, current.token); // the database works out who is asking from this live session
    const entries: AuditEntry[] = [];
    const deps: SelfDeps = { db, now, writeAudit: async (_db, e) => void entries.push(e), client: { ipAddress: null, userAgent: "vitest" } };
    return { me, other, org, ctx, deps, entries, current, elsewhere };
  }

  it("shows an Employee their own account, and only their own", async () => {
    const w = await world();
    expect(await getMyAccount(db, w.ctx)).toMatchObject({ name: "Meera Shah", email: w.me.email, role: "EMPLOYEE", organizationName: "Self Org" });
    // Without the self-service permission there is nothing to see.
    await expect(getMyAccount(db, { ...w.ctx, permissions: new Set() })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updates the signed-in person's own name, and nobody else's", async () => {
    const w = await world();
    await updateMyName(w.deps, w.ctx, "  Meera   S. Shah ");
    expect((await owner.user.findUniqueOrThrow({ where: { id: w.me.id } })).name).toBe("Meera S. Shah");
    expect((await owner.user.findUniqueOrThrow({ where: { id: w.other.id } })).name).toBe("Other Person");
    expect(w.entries.at(-1)).toMatchObject({ action: "self.name_changed", actorUserId: w.me.id, entityId: w.me.id });
    expect(JSON.stringify(w.entries)).not.toContain("Meera S. Shah"); // the name itself is not copied into the audit log
    await expect(updateMyName(w.deps, w.ctx, "x")).rejects.toMatchObject({ code: "invalid" });
    await expect(updateMyName(w.deps, w.ctx, "12345")).rejects.toMatchObject({ code: "invalid" });
  });

  it("changes the password only with the current one, and signs out the other devices", async () => {
    const w = await world();
    await expect(changeMyPassword(w.deps, w.ctx, { currentPassword: "wrong-one-entirely", newPassword: NEW, confirmPassword: NEW })).rejects.toMatchObject({ fieldErrors: { currentPassword: expect.any(String) } });
    await expect(changeMyPassword(w.deps, w.ctx, { currentPassword: OLD, newPassword: "short", confirmPassword: "short" })).rejects.toMatchObject({ fieldErrors: { newPassword: expect.any(String) } });
    await expect(changeMyPassword(w.deps, w.ctx, { currentPassword: OLD, newPassword: NEW, confirmPassword: `${NEW}x` })).rejects.toMatchObject({ fieldErrors: { confirmPassword: expect.any(String) } });
    await expect(changeMyPassword(w.deps, w.ctx, { currentPassword: OLD, newPassword: OLD, confirmPassword: OLD })).rejects.toMatchObject({ fieldErrors: { newPassword: expect.any(String) } });
    await expect(changeMyPassword(w.deps, w.ctx, { currentPassword: OLD, newPassword: "Meera-Shah-Password-1", confirmPassword: "Meera-Shah-Password-1" })).rejects.toMatchObject({ fieldErrors: { newPassword: expect.any(String) } });
    // Nothing changed so far.
    expect(await verifyPassword(OLD, (await owner.user.findUniqueOrThrow({ where: { id: w.me.id } })).passwordHash)).toBe(true);

    await changeMyPassword(w.deps, w.ctx, { currentPassword: OLD, newPassword: NEW, confirmPassword: NEW });
    const user = await owner.user.findUniqueOrThrow({ where: { id: w.me.id } });
    expect(await verifyPassword(NEW, user.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD, user.passwordHash)).toBe(false);
    // This browser stays signed in; the other device is signed out.
    expect((await owner.session.findUniqueOrThrow({ where: { id: w.current.sessionId } })).revokedAt).toBeNull();
    expect((await owner.session.findUniqueOrThrow({ where: { id: w.elsewhere.sessionId } })).revokedReason).toBe("password_changed");
    expect(w.entries.at(-1)).toMatchObject({ action: "self.password_changed", metadata: { otherSessionsEnded: 1 } });
    expect(JSON.stringify(w.entries)).not.toContain(NEW);
  });

  it("works the same for HR Managers and Super Admins (they are employees too)", async () => {
    for (const key of ["HR_MANAGER", "SUPER_ADMIN"] as const) {
      const w = await world(key);
      expect((await getMyAccount(db, w.ctx)).role).toBe(key);
      await updateMyName(w.deps, w.ctx, "Renamed Person");
      expect((await owner.user.findUniqueOrThrow({ where: { id: w.me.id } })).name).toBe("Renamed Person");
    }
  });
});
