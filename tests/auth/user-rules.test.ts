import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { canChangeRole, canInvite, canSetStatus, invitableRoles, roleChoices, type Target } from "@/lib/users/rules";

const perms = (role: RoleKey) => new Set<string>(ROLE_PERMISSIONS[role]);
const actor = (role: RoleKey, userId = "actor") => ({ userId, permissions: perms(role) });
const target = (role: RoleKey | null, extra: Partial<Target> = {}): Target => ({ userId: "target", role, isOwner: false, ...extra });

describe("who may invite whom", () => {
  it("Super Admins invite HR Managers and Employees, whatever the HR switch says", () => {
    expect(invitableRoles(perms("SUPER_ADMIN"), true)).toEqual(["HR_MANAGER", "EMPLOYEE"]);
    expect(invitableRoles(perms("SUPER_ADMIN"), false)).toEqual(["HR_MANAGER", "EMPLOYEE"]);
  });
  it("HR Managers invite Employees only, and only while the switch is on", () => {
    expect(invitableRoles(perms("HR_MANAGER"), true)).toEqual(["EMPLOYEE"]);
    expect(invitableRoles(perms("HR_MANAGER"), false)).toEqual([]);
    expect(canInvite(perms("HR_MANAGER"), "HR_MANAGER", true).ok).toBe(false);
    expect(canInvite(perms("HR_MANAGER"), "EMPLOYEE", false)).toMatchObject({ ok: false, reason: expect.stringContaining("turned off") });
  });
  it("Employees invite nobody, and nobody is invited straight in as a Super Admin", () => {
    expect(invitableRoles(perms("EMPLOYEE"), true)).toEqual([]);
    expect(canInvite(perms("SUPER_ADMIN"), "SUPER_ADMIN", true).ok).toBe(false);
  });
});

describe("who may change whom", () => {
  it("nobody changes their own role or status", () => {
    const me = actor("SUPER_ADMIN", "me");
    expect(canChangeRole(me, target("SUPER_ADMIN", { userId: "me" }), "EMPLOYEE").ok).toBe(false);
    expect(canSetStatus(me, target("SUPER_ADMIN", { userId: "me" })).ok).toBe(false);
  });
  it("the owner always stays an active Super Admin", () => {
    const owner = target("SUPER_ADMIN", { isOwner: true });
    expect(canChangeRole(actor("SUPER_ADMIN"), owner, "HR_MANAGER").ok).toBe(false);
    expect(canSetStatus(actor("SUPER_ADMIN"), owner).ok).toBe(false);
  });
  it("a Super Admin may change anyone else's role, including to and from Super Admin", () => {
    const sa = actor("SUPER_ADMIN");
    expect(canChangeRole(sa, target("EMPLOYEE"), "HR_MANAGER").ok).toBe(true);
    expect(canChangeRole(sa, target("HR_MANAGER"), "SUPER_ADMIN").ok).toBe(true);
    expect(canChangeRole(sa, target("SUPER_ADMIN"), "EMPLOYEE").ok).toBe(true);
    expect(canChangeRole(sa, target("EMPLOYEE"), "EMPLOYEE").ok).toBe(false); // no change
    expect(roleChoices(sa, target("EMPLOYEE"))).toEqual(["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"]);
  });
  it("an HR Manager can change no roles at all", () => {
    const hr = actor("HR_MANAGER");
    for (const from of ["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"] as const) {
      for (const to of ["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"] as const) expect(canChangeRole(hr, target(from), to).ok, `${from}->${to}`).toBe(false);
    }
    expect(roleChoices(hr, target("EMPLOYEE"))).toEqual(["EMPLOYEE"]); // only the current role: no menu
  });
  it("an HR Manager may deactivate Employees only", () => {
    const hr = actor("HR_MANAGER");
    expect(canSetStatus(hr, target("EMPLOYEE")).ok).toBe(true);
    expect(canSetStatus(hr, target("HR_MANAGER")).ok).toBe(false);
    expect(canSetStatus(hr, target("SUPER_ADMIN")).ok).toBe(false);
  });
  it("an Employee may change nobody", () => {
    const emp = actor("EMPLOYEE");
    expect(canSetStatus(emp, target("EMPLOYEE")).ok).toBe(false);
    expect(roleChoices(emp, target("EMPLOYEE"))).toEqual(["EMPLOYEE"]);
  });
});
