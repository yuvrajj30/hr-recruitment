// The three real roles, read from the test database (the three_roles migration creates them).
// Tests use these instead of inventing roles: the database refuses any role other than the three.
import type { Db } from "@/lib/db";
import { ROLE_KEYS, type RoleKey } from "@/lib/auth/roles";

export async function realRoleIds(db: Db): Promise<Record<RoleKey, string>> {
  const rows = await db.role.findMany({ where: { key: { in: [...ROLE_KEYS] } }, select: { id: true, key: true } });
  const ids = Object.fromEntries(rows.map((r) => [r.key, r.id])) as Partial<Record<RoleKey, string>>;
  for (const key of ROLE_KEYS) {
    if (!ids[key]) throw new Error(`role ${key} is missing from the test database: apply the migrations first (prisma migrate deploy)`);
  }
  return ids as Record<RoleKey, string>;
}
