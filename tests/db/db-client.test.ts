// Checks that the app's database client works and really connects as the RESTRICTED runtime role.
// Runs only against the DISPOSABLE test database (TEST_RUNTIME_URL must point at "..._test").
// It only reads; it never writes anything.
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@/lib/db";

const runtimeUrl = process.env.TEST_RUNTIME_URL;
const enabled = Boolean(runtimeUrl && /_test\b/.test(new URL(runtimeUrl).pathname));

describe.skipIf(!enabled)("database client (test database)", () => {
  const db = createDb(runtimeUrl!);
  afterAll(async () => {
    await db.$disconnect();
  });

  it("connects as the restricted hr_runtime account, not the owner", async () => {
    const rows = await db.$queryRaw<{ who: string }[]>`SELECT current_user AS who`;
    expect(rows[0].who).toBe("hr_runtime");
  });
  it("can read the new Milestone 2 tables through the generated client", async () => {
    expect(await db.session.count()).toBeGreaterThanOrEqual(0);
    expect(await db.authLoginAttempt.count()).toBeGreaterThanOrEqual(0);
  });
});
