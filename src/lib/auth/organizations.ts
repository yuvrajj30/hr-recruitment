import "server-only";
import type { Db } from "@/lib/db";

export type OrganizationSummary = { id: string; name: string; slug: string };

// The organisations this person can switch to: their ACTIVE memberships in ACTIVE organisations.
// Read-only. Switching itself still goes through POST /api/auth/organization, which checks again.
export async function listUserOrganizations(db: Pick<Db, "organizationMember">, userId: string): Promise<OrganizationSummary[]> {
  const rows = await db.organizationMember.findMany({
    where: { userId, status: "ACTIVE", organization: { status: "ACTIVE" } },
    select: { organization: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ organization: { name: "asc" } }, { organizationId: "asc" }],
    take: 100,
  });
  return rows.map((r) => r.organization);
}
