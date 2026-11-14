import "server-only";
import type { Db } from "@/lib/db";
import type { AssignableResource, PermissionKey } from "./permission-keys";

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

// How much of a resource a person may read:
//   "all"      - everything in the organization   (x:read)
//   "assigned" - only what is assigned to them    (x:read_assigned), e.g. an interviewer
//   "none"     - nothing
// The list query must apply the matching filter. "assigned" is not a hint, it is a restriction.
export type ReadScope = "all" | "assigned" | "none";

export function readScope(permissions: ReadonlySet<string>, resource: AssignableResource): ReadScope {
  if (permissions.has(`${resource}:read`)) return "all";
  if (permissions.has(`${resource}:read_assigned`)) return "assigned";
  return "none";
}
