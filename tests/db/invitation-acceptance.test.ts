// Accepting invitations, against the DISPOSABLE test database: the service, and the two database
// functions called directly. Audit writes go to a recorder.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import { getAuthContext } from "@/lib/auth/context";
import type { AuthContext } from "@/lib/auth/context";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { hashPassword } from "@/lib/security/password";
import { hashToken } from "@/lib/security/tokens";
import { acceptInvitation, type AcceptDeps, lookupInvitation } from "@/lib/users/accept";
import { createInvitation, revokeInvitation, type UserDeps } from "@/lib/users/members";
import { realRoleIds } from "./roles-helper";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const now = new Date();
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "invite-test.example.test";
const GOOD = "Correct-Horse-Battery-77";

describe.skipIf(!enabled)("accepting invitations (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  let role: Record<RoleKey, string>;
  const orgIds: string[] = [];

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 5 });
    raw = new Client({ connectionString: runtimeUrl });
    await raw.connect();
    role = await realRoleIds(owner);
  });
  afterAll(async () => {
    if (owner) {
      await owner.staffInvitation.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.session.deleteMany({ where: { user: { email: { endsWith: `@${DOMAIN}` } } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds); // an accepted invitation is audited by the database itself
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
    await raw?.end();
  });

  async function world() {
    const admin = await owner.user.create({ data: { email: `admin-${rnd()}@${DOMAIN}`, name: "Admin" } });
    const hrUser = await owner.user.create({ data: { email: `hr-${rnd()}@${DOMAIN}`, name: "Hari" } });
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: "Invite Org", ownerUserId: admin.id } });
    orgIds.push(org.id);
    const saMember = await owner.organizationMember.create({ data: { organizationId: org.id, userId: admin.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role.SUPER_ADMIN }] } } });
    const hrMember = await owner.organizationMember.create({ data: { organizationId: org.id, userId: hrUser.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role.HR_MANAGER }] } } });
    const ctx = (u: typeof admin, key: RoleKey, memberId: string): AuthContext => ({
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: u.id, email: u.email, name: u.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId, expiresAt: now, absoluteExpiresAt: now, roleKeys: [key], permissions: new Set(ROLE_PERMISSIONS[key]),
    });
    const entries: AuditEntry[] = [];
    const writeAudit = async (_db: unknown, e: AuditEntry) => void entries.push(e);
    const userDeps: UserDeps = { db, now, writeAudit, client: { ipAddress: null, userAgent: "vitest" }, appOrigin: "https://hr.example.test" };
    const acceptDeps: AcceptDeps = { db, now, timings, client: { ipAddress: "203.0.113.7", userAgent: "vitest" } };
    // Each with a real, live session: the database works out who is asking from it.
    const sa = await giveSession(owner, ctx(admin, "SUPER_ADMIN", saMember.id));
    const hr = await giveSession(owner, ctx(hrUser, "HR_MANAGER", hrMember.id));
    const invite = async (email: string, key: RoleKey = "EMPLOYEE", by = sa) => {
      const r = await createInvitation(userDeps, by, { email, name: "Invited Person", role: key });
      return { ...r, token: r.link.split("/invite/")[1]! };
    };
    return { org, admin, hrUser, hrMember, sa, hr, userDeps, acceptDeps, entries, invite };
  }

  it("shows a valid invitation, and nothing at all for a wrong, malformed or missing token", async () => {
    const w = await world();
    const email = `new-${rnd()}@${DOMAIN}`;
    const inv = await w.invite(email, "HR_MANAGER");
    expect(await lookupInvitation(db, inv.token)).toMatchObject({ organizationName: "Invite Org", email, role: "HR_MANAGER", accountExists: false });
    expect(await lookupInvitation(db, inv.token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(await lookupInvitation(db, "short")).toBeNull();
    expect(await lookupInvitation(db, undefined)).toBeNull();
  });

  it("creates a new account with the person's own password, joins them with the invited role, and signs them in", async () => {
    const w = await world();
    const email = `new-${rnd()}@${DOMAIN}`;
    const inv = await w.invite(email, "EMPLOYEE");
    const result = await acceptInvitation(w.acceptDeps, inv.token, { name: " Neha Joshi ", password: GOOD, confirmPassword: GOOD });

    const user = await owner.user.findUniqueOrThrow({ where: { email }, include: { memberships: { include: { roles: { include: { role: true } } } } } });
    expect(user).toMatchObject({ name: "Neha Joshi", status: "ACTIVE" });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user.passwordHash).not.toContain(GOOD);
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]).toMatchObject({ organizationId: w.org.id, status: "ACTIVE", invitedById: w.admin.id });
    expect(user.memberships[0]!.roles.map((r) => r.role.key)).toEqual(["EMPLOYEE"]);
    expect(await owner.staffInvitation.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ acceptedUserId: user.id });

    // The new session works and carries exactly the Employee's permissions.
    const ctx = await getAuthContext(db, result.sessionToken, { now, timings, touch: false });
    expect(ctx.ok && ctx.ctx.organization?.id).toBe(w.org.id);
    expect(ctx.ok && [...ctx.ctx.permissions].sort()).toEqual([...ROLE_PERMISSIONS.EMPLOYEE].sort());
    // The DATABASE writes this audit record itself, in the same step as the acceptance.
    const audit = await owner.auditLog.findMany({ where: { organizationId: w.org.id, action: "invitation.accepted" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: user.id, entityType: "staff_invitation", metadata: { role: "EMPLOYEE", newAccount: true } });
    expect(JSON.stringify(audit)).not.toContain(GOOD);
    expect(JSON.stringify(w.entries)).not.toContain(GOOD);
  });

  it("works only once, and never after it is revoked, replaced or expired", async () => {
    const w = await world();
    const email = `once-${rnd()}@${DOMAIN}`;
    const inv = await w.invite(email);
    await acceptInvitation(w.acceptDeps, inv.token, { name: "Once", password: GOOD, confirmPassword: GOOD });
    await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "Again", password: GOOD, confirmPassword: GOOD })).rejects.toMatchObject({ code: "invalid" });
    expect(await lookupInvitation(db, inv.token)).toBeNull();

    const revoked = await w.invite(`rev-${rnd()}@${DOMAIN}`);
    await revokeInvitation(w.userDeps, w.sa, revoked.id);
    expect(await lookupInvitation(db, revoked.token)).toBeNull();

    const replacedEmail = `repl-${rnd()}@${DOMAIN}`;
    const old = await w.invite(replacedEmail);
    const fresh = await w.invite(replacedEmail);
    expect(await lookupInvitation(db, old.token)).toBeNull();
    expect(await lookupInvitation(db, fresh.token)).not.toBeNull();

    const expired = await w.invite(`exp-${rnd()}@${DOMAIN}`);
    await owner.staffInvitation.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 9 * 86400_000), expiresAt: new Date(Date.now() - 1000) } });
    expect(await lookupInvitation(db, expired.token)).toBeNull();
    await expect(acceptInvitation(w.acceptDeps, expired.token, { name: "Late", password: GOOD, confirmPassword: GOOD })).rejects.toMatchObject({ code: "invalid" });
  });

  it("cannot be used twice even by two clicks at the same moment", async () => {
    const w = await world();
    const inv = await w.invite(`race-${rnd()}@${DOMAIN}`);
    const attempt = () => acceptInvitation(w.acceptDeps, inv.token, { name: "Racer", password: GOOD, confirmPassword: GOOD });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await owner.organizationMember.count({ where: { organizationId: w.org.id, user: { email: { startsWith: "race-" } } } })).toBe(1);
  });

  it("checks the new password and name before creating anything", async () => {
    const w = await world();
    const email = `weak-${rnd()}@${DOMAIN}`;
    const inv = await w.invite(email);
    await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "Weak", password: "short", confirmPassword: "short" })).rejects.toMatchObject({ fieldErrors: { password: expect.any(String) } });
    await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "Mismatch", password: GOOD, confirmPassword: `${GOOD}x` })).rejects.toMatchObject({ fieldErrors: { confirmPassword: expect.any(String) } });
    await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "Pat", password: `${email.split("@")[0]}-Secret-1`, confirmPassword: `${email.split("@")[0]}-Secret-1` })).rejects.toMatchObject({ fieldErrors: { password: expect.any(String) } });
    await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "", password: GOOD, confirmPassword: GOOD })).rejects.toMatchObject({ fieldErrors: { name: expect.any(String) } });
    expect(await owner.user.count({ where: { email } })).toBe(0);
    expect(await lookupInvitation(db, inv.token)).not.toBeNull(); // still usable
  });

  it("makes an existing account prove its own password, and never changes that password", async () => {
    const w = await world();
    const email = `existing-${rnd()}@${DOMAIN}`;
    const originalHash = await hashPassword(GOOD);
    await owner.user.create({ data: { email, name: "Already Here", passwordHash: originalHash } });
    const inv = await w.invite(email, "HR_MANAGER");
    expect(await lookupInvitation(db, inv.token)).toMatchObject({ accountExists: true });
    await expect(acceptInvitation(w.acceptDeps, inv.token, { password: "Wrong-Password-123" })).rejects.toMatchObject({ fieldErrors: { password: expect.any(String) } });
    const ok = await acceptInvitation(w.acceptDeps, inv.token, { password: GOOD, name: "Ignored Name" });
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ name: "Already Here", passwordHash: originalHash });
    expect(ok.organizationId).toBe(w.org.id);
    const audit = await owner.auditLog.findMany({ where: { organizationId: w.org.id, action: "invitation.accepted" } });
    expect(audit.at(-1)).toMatchObject({ metadata: { role: "HR_MANAGER", newAccount: false } });
  });

  it("refuses the database functions' misuse directly, without any application code", async () => {
    const w = await world();
    const email = `direct-${rnd()}@${DOMAIN}`;
    await owner.user.create({ data: { email, name: "Direct", passwordHash: await hashPassword(GOOD) } });
    const inv = await w.invite(email);
    const call = async (sql: string, params: unknown[]) => {
      await raw.query("BEGIN");
      try {
        return { rows: (await raw.query(sql, params)).rows, error: undefined as string | undefined };
      } catch (e) {
        return { rows: [], error: (e as Error).message };
      } finally {
        await raw.query("ROLLBACK");
      }
    };
    const hash = hashToken(inv.token);
    // The session the function would create: a token fingerprint and its two deadlines.
    const SESSION = `'${"a".repeat(64)}', now() + interval '1 hour', now() + interval '12 hours', now(), NULL, NULL`;
    // An existing account is joined only with ITS password, checked by the database: a wrong one, or none, is refused.
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'X', 'Another-Password-99', ${SESSION})`, [hash])).error).toMatch(/wrong_password/);
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'X', NULL, ${SESSION})`, [hash])).error).toMatch(/wrong_password/);
    // The old three-argument form (which trusted the application's own password check) no longer exists.
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'X', NULL)`, [hash])).error).toMatch(/does not exist/);
    // A new account needs a password and a name.
    const inv2 = await w.invite(`direct2-${rnd()}@${DOMAIN}`);
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'Name', 'short', ${SESSION})`, [hashToken(inv2.token)])).error).toMatch(/password_required/);
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'N', 'Long-Enough-Pass-77', ${SESSION})`, [hashToken(inv2.token)])).error).toMatch(/name_required/);
    // A malformed session fingerprint is refused before anything else.
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'Name', 'Long-Enough-Pass-77', 'not-a-hash', now() + interval '1 hour', now() + interval '12 hours', now(), NULL, NULL)`, [hashToken(inv2.token)])).error).toMatch(/invalid_request/);
    // An unknown fingerprint does nothing.
    expect((await call(`SELECT * FROM app_accept_invitation($1, 'Name', 'Long-Enough-Pass-77', ${SESSION})`, ["0".repeat(64)])).error).toMatch(/invitation_invalid/);
    expect((await call(`SELECT * FROM app_invitation_lookup($1)`, ["0".repeat(64)])).rows).toEqual([]);
    // The invitations table itself stays closed to anyone without a staff identity.
    expect((await call(`SELECT count(*)::int AS n FROM staff_invitations`, [])).rows[0]).toEqual({ n: 0 });
  });

  it("does not join someone who is already a member, or whose account is disabled", async () => {
    const w = await world();
    // Already a member: the invitation can't even be created for them...
    await expect(w.invite(w.admin.email)).rejects.toMatchObject({ code: "invalid" });
    // ...and a disabled account cannot accept.
    const email = `disabled-${rnd()}@${DOMAIN}`;
    await owner.user.create({ data: { email, name: "Disabled", passwordHash: await hashPassword(GOOD), status: "DISABLED" } });
    const inv = await w.invite(email);
    await expect(acceptInvitation(w.acceptDeps, inv.token, { password: GOOD })).rejects.toMatchObject({ code: "invalid" });
  });

  it("stops working while the organisation is not active", async () => {
    const w = await world();
    const email = `inactive-${rnd()}@${DOMAIN}`;
    const inv = await w.invite(email);
    await owner.organization.update({ where: { id: w.org.id }, data: { status: "SUSPENDED" } });
    try {
      expect(await lookupInvitation(db, inv.token)).toBeNull();
      await expect(acceptInvitation(w.acceptDeps, inv.token, { name: "Late Joiner", password: GOOD, confirmPassword: GOOD })).rejects.toMatchObject({ code: "invalid" });
      expect(await owner.user.count({ where: { email } })).toBe(0); // nothing was created
    } finally {
      await owner.organization.update({ where: { id: w.org.id }, data: { status: "ACTIVE" } });
    }
    expect(await lookupInvitation(db, inv.token)).not.toBeNull(); // good again once the organisation is active
  });

  it("is only good while the person who sent it may still send that kind of invitation", async () => {
    const w = await world();
    const hrInvitee = `byhr-${rnd()}@${DOMAIN}`;
    const byHr = await w.invite(hrInvitee, "EMPLOYEE", w.hr);
    const bySa = await w.invite(`bysa-${rnd()}@${DOMAIN}`, "EMPLOYEE");
    const refused = (token: string) => expect(acceptInvitation(w.acceptDeps, token, { name: "Late Joiner", password: GOOD, confirmPassword: GOOD })).rejects.toMatchObject({ code: "invalid" });
    expect(await lookupInvitation(db, byHr.token)).not.toBeNull();

    // The HR Manager who sent it is deactivated: their invitation stops working, the Super Admin's does not.
    await owner.organizationMember.update({ where: { id: w.hrMember.id }, data: { status: "SUSPENDED" } });
    expect(await lookupInvitation(db, byHr.token)).toBeNull();
    await refused(byHr.token);
    expect(await lookupInvitation(db, bySa.token)).not.toBeNull();
    await owner.organizationMember.update({ where: { id: w.hrMember.id }, data: { status: "ACTIVE" } });
    expect(await lookupInvitation(db, byHr.token)).not.toBeNull(); // reactivated: good again

    // A Super Admin switches off "HR Managers may invite Employees".
    await owner.organization.update({ where: { id: w.org.id }, data: { hrCanInviteEmployees: false } });
    expect(await lookupInvitation(db, byHr.token)).toBeNull();
    await refused(byHr.token);
    expect(await lookupInvitation(db, bySa.token)).not.toBeNull();
    await owner.organization.update({ where: { id: w.org.id }, data: { hrCanInviteEmployees: true } });

    // The sender is made an Employee: no longer someone who may invite.
    await owner.organizationMemberRole.updateMany({ where: { memberId: w.hrMember.id }, data: { roleId: role.EMPLOYEE } });
    expect(await lookupInvitation(db, byHr.token)).toBeNull();
    await refused(byHr.token);
    await owner.organizationMemberRole.updateMany({ where: { memberId: w.hrMember.id }, data: { roleId: role.HR_MANAGER } });

    // Nothing was created by any refused attempt; with the sender in good standing again it works.
    expect(await owner.user.count({ where: { email: hrInvitee } })).toBe(0);
    const joined = await acceptInvitation(w.acceptDeps, byHr.token, { name: "Late Joiner", password: GOOD, confirmPassword: GOOD });
    expect(joined.organizationId).toBe(w.org.id);
  });

  it("copes with two organisations inviting the same new person, accepted at the same moment", async () => {
    const [a, b] = [await world(), await world()];
    const email = `twice-${rnd()}@${DOMAIN}`;
    const [ia, ib] = [await a.invite(email), await b.invite(email)];
    const OTHER = "Another-Good-Pass-91";
    const results = await Promise.allSettled([
      acceptInvitation(a.acceptDeps, ia.token, { name: "Twice Invited", password: GOOD, confirmPassword: GOOD }),
      acceptInvitation(b.acceptDeps, ib.token, { name: "Twice Invited", password: OTHER, confirmPassword: OTHER }),
    ]);
    // Exactly one creates the account and joins; the other is told to use that account (never a second account,
    // never a membership without one, never a server error).
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["conflict", "invalid"]).toContain((lost.reason as { code?: string }).code);
    expect(await owner.user.count({ where: { email } })).toBe(1);
    expect(await owner.organizationMember.count({ where: { user: { email } } })).toBe(1);
    // The other invitation is still good: the person joins it by proving the new account's password.
    const [loser, loserInv, winnerPassword] = results[0]!.status === "fulfilled" ? [b, ib, GOOD] : [a, ia, OTHER];
    expect((await lookupInvitation(db, loserInv.token))?.accountExists).toBe(true);
    await expect(acceptInvitation(loser.acceptDeps, loserInv.token, { password: "Not-That-Password-1" })).rejects.toMatchObject({ code: "invalid" });
    const second = await acceptInvitation(loser.acceptDeps, loserInv.token, { password: winnerPassword });
    expect(second.organizationId).toBe(loser.org.id);
    expect(await owner.organizationMember.count({ where: { user: { email } } })).toBe(2);
  });
});
