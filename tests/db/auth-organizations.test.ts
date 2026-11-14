// Runs against the DISPOSABLE test database only (names ending "_test").
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listUserOrganizations } from "@/lib/auth/organizations";
import { createDb, type Db } from "@/lib/db";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");

describe.skipIf(!enabled)("organisations a person can switch to (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 2 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  const user = async () => {
    const u = await owner.user.create({ data: { email: `orgs-${rnd()}${rnd()}@example.test`, name: "Orgs Test" } });
    userIds.push(u.id);
    return u;
  };
  const org = async (ownerUserId: string, name: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") => {
    const o = await owner.organization.create({ data: { slug: `o-${rnd()}${rnd()}`, name, ownerUserId, status } });
    orgIds.push(o.id);
    return o;
  };

  it("lists active memberships in active organisations, by name, and nothing else", async () => {
    const me = await user();
    const other = await user();
    const tag = rnd();
    const beta = await org(me.id, `Beta ${tag}`);
    const alpha = await org(me.id, `Alpha ${tag}`);
    const suspendedOrg = await org(me.id, `Gamma ${tag}`, "SUSPENDED");
    const suspendedMembership = await org(me.id, `Delta ${tag}`);
    const notMine = await org(other.id, `Epsilon ${tag}`);
    for (const o of [beta, alpha, suspendedOrg]) {
      await owner.organizationMember.create({ data: { organizationId: o.id, userId: me.id, status: "ACTIVE" } });
    }
    await owner.organizationMember.create({ data: { organizationId: suspendedMembership.id, userId: me.id, status: "SUSPENDED" } });
    await owner.organizationMember.create({ data: { organizationId: notMine.id, userId: other.id, status: "ACTIVE" } });

    const list = await listUserOrganizations(db, me.id);
    expect(list.map((o) => o.name)).toEqual([`Alpha ${tag}`, `Beta ${tag}`]);
    expect(Object.keys(list[0]!).sort()).toEqual(["id", "name", "slug"]);
    expect(await listUserOrganizations(db, other.id)).toEqual([{ id: notMine.id, name: notMine.name, slug: notMine.slug }]);
  });
});
