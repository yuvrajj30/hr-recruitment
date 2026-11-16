import "server-only";
import type { Db } from "@/lib/db";
import type { PermissionKey } from "./permission-keys";

// What a person may do inside one organization.
//   person -> membership (one per organization) -> roles -> permissions
// Permissions are loaded from the database on every request, so a role change takes effect immediately.

export type Access = {
  roleKeys: string[];
  permissions: ReadonlySet<string>;
};

export const NO_ACCESS: Access = { roleKeys: [], permissions: new Set<string>() };

// One query: the roles of THIS membership, with their permissions merged together.
// Roles and permissions of other members, or of the same person's other organizations, are never included.
export async function loadAccess(db: Pick<Db, "organizationMemberRole">, memberId: string): Promise<Access> {
  const rows = await db.organizationMemberRole.findMany({
    where: { memberId },
    select: {
      role: {
        select: {
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  });
  const roleKeys = new Set<string>();
  const permissions = new Set<string>();
  for (const { role } of rows) {
    roleKeys.add(role.key);
    for (const { permission } of role.permissions) permissions.add(permission.key);
  }
  return { roleKeys: [...roleKeys].sort(), permissions };
}

export const hasPermission = (permissions: ReadonlySet<string>, key: PermissionKey): boolean =>
  permissions.has(key);

export const hasAnyPermission = (permissions: ReadonlySet<string>, keys: readonly PermissionKey[]): boolean =>
  keys.some((k) => permissions.has(k));

// Whether a person may read a recruitment resource at all. With the three fixed roles there is no
// "only what is assigned to me" level any more: Super Admins and HR Managers read everything in their
// organisation, Employees read nothing. Kept as a function so pages and services ask one question.
export type ReadableResource = "candidate" | "application" | "interview";
export type ReadScope = "all" | "none";

export function readScope(permissions: ReadonlySet<string>, resource: ReadableResource): ReadScope {
  return permissions.has(`${resource}:read`) ? "all" : "none";
}
