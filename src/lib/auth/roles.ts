// The three roles of HRMS, and exactly what each one may do. This file is the single source of truth:
//   - prisma/seed.ts builds the roles from it,
//   - the three-role migration writes the same lists (a database test compares the two),
//   - the user-management screens use it to decide who may invite or change whom.
//
// There are exactly three roles. The database refuses any other role key, and every member of an
// organisation holds exactly one of them. Permissions are fixed per role; there is no permission editor.
// Code still asks for permissions (e.g. "job:create"), never for a role name, so a module never
// hard-codes "only Super Admin may...".

import { PERMISSION_KEYS, type PermissionKey } from "./permission-keys";

export const ROLE_KEYS = ["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const isRoleKey = (value: unknown): value is RoleKey => typeof value === "string" && (ROLE_KEYS as readonly string[]).includes(value);

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: "Super Admin",
  HR_MANAGER: "HR Manager",
  EMPLOYEE: "Employee",
};

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  SUPER_ADMIN: "Complete control of the organisation: users, roles, settings, security and every module",
  HR_MANAGER: "Runs day-to-day HR: recruitment, employees, attendance and leave; cannot change system settings or Super Admins",
  EMPLOYEE: "Self-service only: their own profile, work information, attendance and leave",
};

// Permissions only a Super Admin holds: system-wide control, security, ownership and administrators.
const SUPER_ADMIN_ONLY: readonly PermissionKey[] = [
  "org:update",
  "settings:security",
  "integration:read",
  "integration:manage",
  "audit:read",
  "user:invite_hr",
  "user:manage_hr",
  "user:manage_super_admin",
  "job:delete",
  "candidate:delete",
];

// Everything an employee may do about THEMSELVES. Every role has these (HR Managers and Super Admins
// are employees of the organisation too).
const SELF_SERVICE: readonly PermissionKey[] = [
  "self:profile_read",
  "self:profile_update",
  "self:attendance_read",
  "self:leave_apply",
  "self:leave_read",
  "notification:read",
];

export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  SUPER_ADMIN: [...PERMISSION_KEYS],
  HR_MANAGER: PERMISSION_KEYS.filter((k) => !SUPER_ADMIN_ONLY.includes(k)),
  EMPLOYEE: [...SELF_SERVICE],
};

// Which roles a person may hand out in an invitation. Nobody is invited straight in as a Super Admin.
export const INVITABLE_ROLES: readonly RoleKey[] = ["HR_MANAGER", "EMPLOYEE"];
