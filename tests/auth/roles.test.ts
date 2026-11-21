import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@/lib/auth/permission-keys";
import { INVITABLE_ROLES, isRoleKey, ROLE_KEYS, ROLE_PERMISSIONS } from "@/lib/auth/roles";

const has = (role: keyof typeof ROLE_PERMISSIONS, key: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(key);

describe("the three roles", () => {
  it("are exactly Super Admin, HR Manager and Employee", () => {
    expect(ROLE_KEYS).toEqual(["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"]);
    expect(isRoleKey("RECRUITER")).toBe(false);
    expect(isRoleKey("ADMIN")).toBe(false);
    expect(isRoleKey("EMPLOYEE")).toBe(true);
  });

  it("only use permissions that exist", () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const key of ROLE_KEYS) for (const p of ROLE_PERMISSIONS[key]) expect(known.has(p), `${key}: ${p}`).toBe(true);
  });

  it("give the Super Admin everything", () => {
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("keep system control, security, ownership and administrators away from HR Managers", () => {
    for (const p of ["org:update", "settings:security", "integration:manage", "audit:read", "user:invite_hr", "user:manage_hr", "user:manage_super_admin"]) {
      expect(has("HR_MANAGER", p), p).toBe(false);
    }
  });

  it("give HR Managers the full operational HR work", () => {
    for (const p of [
      "job:create", "job:publish", "job:close", "application:read", "application:move_stage", "candidate:read", "document:read",
      "interview:schedule", "feedback:submit", "decision:make", "offer:issue", "onboarding:manage",
      "employee:manage", "assignment:manage", "attendance:manage", "leave:approve", "report:read",
      "user:read", "user:invite_employee", "user:manage_employee",
    ]) {
      expect(has("HR_MANAGER", p), p).toBe(true);
    }
  });

  it("give Employees self-service only: nothing about other people, recruitment or administration", () => {
    expect([...ROLE_PERMISSIONS.EMPLOYEE].sort()).toEqual(["notification:read", "self:attendance_clock", "self:attendance_read", "self:leave_apply", "self:leave_read", "self:profile_read", "self:profile_update"]);
    for (const p of ROLE_PERMISSIONS.EMPLOYEE) expect(p.startsWith("self:") || p === "notification:read", p).toBe(true);
  });

  it("let every role use self-service (HR Managers and Super Admins are employees too)", () => {
    for (const key of ROLE_KEYS) for (const p of ROLE_PERMISSIONS.EMPLOYEE) expect(has(key, p), `${key}: ${p}`).toBe(true);
  });

  it("let only HR roles set up leave (types, holidays, adjustments)", () => {
    expect(has("SUPER_ADMIN", "leave:manage")).toBe(true);
    expect(has("HR_MANAGER", "leave:manage")).toBe(true);
    expect(has("EMPLOYEE", "leave:manage")).toBe(false);
  });

  it("never invite anyone straight in as a Super Admin", () => {
    expect(INVITABLE_ROLES).toEqual(["HR_MANAGER", "EMPLOYEE"]);
  });
});
