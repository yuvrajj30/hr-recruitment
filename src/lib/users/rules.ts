// Who may invite, change or deactivate whom. Pure functions (no database), so every combination is
// unit-tested. The same rules are enforced again by the database (row-level security and triggers).
//
//   Super Admin  - invites HR Managers and Employees; changes anyone's role or status (never their own)
//   HR Manager   - invites Employees (only while the organisation allows it); deactivates/reactivates
//                  Employees; cannot change roles, cannot touch Super Admins or other HR Managers
//   Employee     - none of this
//   Everyone     - can never change their own role or status; the organisation owner stays an
//                  active Super Admin (no ownership transfer yet)

import type { PermissionKey } from "@/lib/auth/permission-keys";
import { INVITABLE_ROLES, type RoleKey } from "@/lib/auth/roles";

type Perms = ReadonlySet<string>;

// The permission needed to manage someone who holds (or is being given) this role.
export const MANAGE_PERMISSION: Record<RoleKey, PermissionKey> = {
  SUPER_ADMIN: "user:manage_super_admin",
  HR_MANAGER: "user:manage_hr",
  EMPLOYEE: "user:manage_employee",
};

export const INVITE_PERMISSION: Partial<Record<RoleKey, PermissionKey>> = {
  HR_MANAGER: "user:invite_hr",
  EMPLOYEE: "user:invite_employee",
};

export type Target = { userId: string; role: RoleKey | null; isOwner: boolean };
export type Actor = { userId: string; permissions: Perms };

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };

// Roles this person may invite people into. HR's Employee invitations also need the organisation switch.
export function invitableRoles(permissions: Perms, hrCanInviteEmployees: boolean): RoleKey[] {
  return INVITABLE_ROLES.filter((role) => {
    const needed = INVITE_PERMISSION[role];
    if (!needed || !permissions.has(needed)) return false;
    // A Super Admin may always invite Employees; for anyone else (an HR Manager) the switch must be on.
    if (role === "EMPLOYEE" && !permissions.has("user:manage_super_admin") && !hrCanInviteEmployees) return false;
    return true;
  });
}

export function canInvite(permissions: Perms, role: RoleKey, hrCanInviteEmployees: boolean): Verdict {
  if (role === "SUPER_ADMIN") return no("Nobody can be invited straight in as a Super Admin. Invite them as an HR Manager, then change their role.");
  if (invitableRoles(permissions, hrCanInviteEmployees).includes(role)) return yes;
  if (role === "EMPLOYEE" && permissions.has("user:invite_employee") && !hrCanInviteEmployees) {
    return no("A Super Admin has turned off invitations by HR Managers.");
  }
  return no("You do not have permission to invite people in that role.");
}

// Activate or deactivate someone.
export function canSetStatus(actor: Actor, target: Target): Verdict {
  if (actor.userId === target.userId) return no("You cannot deactivate or reactivate your own account.");
  if (target.isOwner) return no("The organisation owner cannot be deactivated.");
  if (!target.role) return no("This person has no role; ask a Super Admin.");
  if (!actor.permissions.has(MANAGE_PERMISSION[target.role])) return no("You do not have permission to manage this person.");
  return yes;
}

// Change someone's role.
export function canChangeRole(actor: Actor, target: Target, to: RoleKey): Verdict {
  if (actor.userId === target.userId) return no("You cannot change your own role.");
  if (target.isOwner) return no("The organisation owner must stay a Super Admin.");
  if (target.role === to) return no("This person already has that role.");
  // Both the current role and the new role must be within the actor's authority.
  if (target.role && !actor.permissions.has(MANAGE_PERMISSION[target.role])) return no("You do not have permission to change this person's role.");
  if (!actor.permissions.has(MANAGE_PERMISSION[to])) return no("You do not have permission to give that role.");
  return yes;
}

// The roles to offer in a "change role" menu for this target (empty when nothing is allowed).
export function roleChoices(actor: Actor, target: Target): RoleKey[] {
  return (["SUPER_ADMIN", "HR_MANAGER", "EMPLOYEE"] as const).filter((to) => to === target.role || canChangeRole(actor, target, to).ok);
}
