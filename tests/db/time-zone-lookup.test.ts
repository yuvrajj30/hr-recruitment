// Organisation time zone lookup (migration 20261123000200_time_zone_lookup), against the DISPOSABLE test database only.
// att_org_timezone runs for every shift the rota fill touches and every clock-in. Checking the zone against the
// pg_timezone_names view reads the whole time zone database on each call (~200 ms here), which made the daily rota
// run pass the 30 s statement limit. The check must stay exactly as strict, only fast.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

describe.skipIf(!enabled)("organisation time zone lookup (test database)", () => {
  let owner: Client;
  let runtime: Client;
  let org: string;
  const errorOf = (p: Promise<unknown>) => p.then(() => undefined, (e: Error) => e.message);

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    runtime = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await owner.connect();
    await runtime.connect();
    org = (await owner.query(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).rows[0].id;
  });
  afterAll(async () => {
    await owner?.end();
    await runtime?.end();
  });

  it("answers a valid zone quickly (not by reading the whole time zone database each time)", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query(`UPDATE organizations SET timezone = 'Asia/Kolkata' WHERE id = $1`, [org]);
      await owner.query(`SELECT att_org_timezone($1)`, [org]); // warm up
      const t = performance.now();
      for (let i = 0; i < 20; i++) expect((await owner.query(`SELECT att_org_timezone($1) AS z`, [org])).rows[0].z).toBe("Asia/Kolkata");
      // 20 calls took ~4 s with the pg_timezone_names check; a table lookup takes a few ms.
      expect(performance.now() - t).toBeLessThan(1000);
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("stays as strict: unknown zones and zone abbreviations are still refused", async () => {
    for (const zone of ["Mars/Olympus_Mons", "IST", "UTC+5", ""]) {
      await owner.query("BEGIN");
      try {
        await owner.query(`UPDATE organizations SET timezone = $2 WHERE id = $1`, [org, zone]);
        expect(await errorOf(owner.query(`SELECT att_org_timezone($1)`, [org])), zone).toMatch(/invalid_timezone/);
      } finally {
        await owner.query("ROLLBACK");
      }
    }
    // The same names pg_timezone_names accepts are accepted.
    for (const zone of ["UTC", "Europe/London", "America/Argentina/Buenos_Aires"]) {
      await owner.query("BEGIN");
      try {
        await owner.query(`UPDATE organizations SET timezone = $2 WHERE id = $1`, [org, zone]);
        expect((await owner.query(`SELECT att_org_timezone($1) AS z`, [org])).rows[0].z).toBe(zone);
      } finally {
        await owner.query("ROLLBACK");
      }
    }
  });

  it("keeps the zone list away from the app account", async () => {
    expect(await errorOf(runtime.query(`SELECT count(*) FROM time_zone_names`))).toMatch(/permission denied/);
    const rls = await owner.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_zone_names'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
