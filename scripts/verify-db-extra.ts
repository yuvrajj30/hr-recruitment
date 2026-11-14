// Read-only extra checks for the database accounts:
//   A. Role memberships  - hr_runtime has no borrowed powers
//   B. PUBLIC privileges - "everyone" has no rights on our tables or to create things
//   C. Default privileges - tables created by FUTURE migrations get exactly the intended rights
// It also prints which database each connection really talks to.
//
// Usage (PowerShell, project folder):  npm run db:verify-extra
// It reads .env (real database) and .env.test (test database). It never changes the real database.
// The only "write" is one throw-away table created inside a transaction on the TEST database
// (name must end in _test) and rolled back at once, to prove future tables get the right rights.
import "dotenv/config";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.test" }); // does not override anything already loaded from .env

type Row = { check: string; ok: boolean; detail?: string };
const rows: Row[] = [];
const notes: string[] = [];
const add = (check: string, ok: boolean, detail?: string) => rows.push({ check, ok, detail });

const DML = ["DELETE", "INSERT", "SELECT", "UPDATE"];
const sameSet = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");

async function one<T = any>(c: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

async function staticChecks(label: string, owner: Client, runtimeName: string, ownerName: string) {
  const p = (s: string) => `[${label}] ${s}`;
  const dbName = (await one(owner, "SELECT current_database() AS d"))[0].d as string;
  const rt = (await one<{ oid: number; rolinherit: boolean }>(
    owner, "SELECT oid::int AS oid, rolinherit FROM pg_roles WHERE rolname = $1", [runtimeName]))[0];
  if (!rt) {
    add(p("runtime role exists"), false, runtimeName);
    return dbName;
  }

  // ---- A. Role memberships -------------------------------------------------
  const member = await one<{ name: string }>(owner,
    `SELECT g.rolname AS name FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE m.member = $1::oid`, [rt.oid]);
  add(p("runtime is a member of no other role (so it borrows no powers)"), member.length === 0, member.map((m) => m.name).join(", "));
  add(p("runtime does not automatically inherit privileges (NOINHERIT)"), rt.rolinherit === false);
  const holders = await one<{ name: string }>(owner,
    `SELECT u.rolname AS name FROM pg_auth_members m
       JOIN pg_roles u ON u.oid = m.member
      WHERE m.roleid = $1::oid`, [rt.oid]);
  add(p("no account is a member of runtime (nobody can act as it by membership)"), holders.length === 0, holders.map((m) => m.name).join(", "));
  const ownerMembers = await one<{ name: string }>(owner,
    `SELECT g.rolname AS name FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = $1`, [ownerName]);
  add(p("owner account is a member of no other role"), ownerMembers.length === 0, ownerMembers.map((m) => m.name).join(", "));

  // ---- B. PUBLIC ("everyone") privileges -----------------------------------
  const pubTables = await one<{ name: string; priv: string }>(owner,
    `SELECT c.relname AS name, a.privilege_type AS priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND a.grantee = 0`);
  add(p("PUBLIC has no rights on any table or sequence in the public schema"), pubTables.length === 0,
    pubTables.slice(0, 5).map((r) => `${r.name}:${r.priv}`).join(", "));
  const pubSchema = await one<{ priv: string }>(owner,
    `SELECT a.privilege_type AS priv FROM pg_namespace n
       CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE n.nspname = 'public' AND a.grantee = 0`);
  add(p("PUBLIC cannot create objects in the public schema"), !pubSchema.some((r) => r.priv === "CREATE"),
    `PUBLIC has: ${pubSchema.map((r) => r.priv).join(", ") || "nothing"}`);
  const pubDb = await one<{ priv: string }>(owner,
    `SELECT a.privilege_type AS priv FROM pg_database d
       CROSS JOIN LATERAL aclexplode(d.datacl) a
      WHERE d.datname = current_database() AND a.grantee = 0`);
  add(p("PUBLIC cannot create schemas in the database"), !pubDb.some((r) => r.priv === "CREATE"));
  const temp = (await one<{ v: boolean }>(owner, "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS v", [runtimeName]))[0].v;
  notes.push(
    temp
      ? `NOTE  [${label}] runtime can create temporary tables (PostgreSQL's built-in default for everyone; not changed by us)`
      : `NOTE  [${label}] runtime cannot create temporary tables`,
  );

  // ---- C. Default privileges for FUTURE tables -----------------------------
  const defaults = await one<{ creator: string; ns: string; kind: string; grantee: number; priv: string }>(owner,
    `SELECT d.defaclrole::regrole::text AS creator, d.defaclnamespace::regnamespace::text AS ns,
            d.defaclobjtype::text AS kind, a.grantee::int AS grantee, a.privilege_type AS priv
       FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a`);
  const forRuntimeOnTables = defaults
    .filter((d) => d.creator === ownerName && d.ns === "public" && d.kind === "r" && d.grantee === rt.oid)
    .map((d) => d.priv);
  add(p("future tables made by the owner give runtime exactly read/add/change/remove"), sameSet(forRuntimeOnTables, DML), forRuntimeOnTables.sort().join(", "));
  add(p("future tables give PUBLIC nothing"), !defaults.some((d) => d.grantee === 0));
  const strays = defaults.filter((d) => d.grantee === rt.oid && !(d.creator === ownerName && d.ns === "public" && d.kind === "r"));
  add(p("no other default rule gives runtime anything (other creators, sequences, functions)"), strays.length === 0,
    strays.map((s) => `${s.creator}/${s.kind}:${s.priv}`).join(", "));
  return dbName;
}

// Proof by doing: create a table as the owner INSIDE a transaction, look at its rights, roll back.
async function futureTableProbe(owner: Client, runtimeName: string, ownerName: string) {
  const p = (s: string) => `[test] ${s}`;
  await owner.query("BEGIN");
  try {
    await owner.query('CREATE TABLE "zz_future_table_probe" (id int)');
    const has = async (priv: string) =>
      (await one<{ v: boolean }>(owner, "SELECT has_table_privilege($1, 'public.zz_future_table_probe', $2) AS v", [runtimeName, priv]))[0].v;
    const granted: string[] = [];
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) if (await has(priv)) granted.push(priv);
    add(p("a brand-new table automatically gives runtime read/add/change/remove"), granted.length === 4, granted.join(", "));
    const bad: string[] = [];
    for (const priv of ["TRUNCATE", "TRIGGER", "REFERENCES"]) if (await has(priv)) bad.push(priv);
    add(p("a brand-new table does NOT give runtime TRUNCATE, TRIGGER or REFERENCES"), bad.length === 0, bad.join(", "));
    const pub = await one(owner,
      `SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE c.oid = 'public.zz_future_table_probe'::regclass AND a.grantee = 0`);
    add(p("a brand-new table gives PUBLIC nothing"), pub.length === 0);
    const who = (await one<{ o: string }>(owner, "SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.zz_future_table_probe'::regclass"))[0].o;
    add(p("a brand-new table is owned by the owner account"), who === ownerName, who);
  } finally {
    await owner.query("ROLLBACK");
  }
  const left = await one(owner, "SELECT 1 FROM pg_class WHERE relname = 'zz_future_table_probe'");
  add(p("the throw-away table is gone after rollback"), left.length === 0);
}

async function main() {
  const realRuntime = process.env.DATABASE_URL;
  const realOwner = process.env.MIGRATION_DATABASE_URL;
  const testRuntime = process.env.TEST_RUNTIME_URL;
  const testOwner = process.env.TEST_OWNER_URL;
  if (!realRuntime || !realOwner) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL must be set in .env");
  if (!testRuntime || !testOwner) throw new Error("TEST_RUNTIME_URL and TEST_OWNER_URL must be set in .env.test");
  if (!/_test$/.test(new URL(testOwner).pathname.replace(/^\//, ""))) {
    throw new Error("TEST_OWNER_URL does not point at a database whose name ends in _test. Stopping.");
  }

  const mk = (u: string) => new Client({ connectionString: u });
  const clients = { realOwner: mk(realOwner), realRuntime: mk(realRuntime), testOwner: mk(testOwner), testRuntime: mk(testRuntime) };
  await Promise.all(Object.values(clients).map((c) => c.connect()));
  try {
    const who = async (c: Client) => (await one<{ u: string; d: string }>(c, "SELECT current_user AS u, current_database() AS d"))[0];
    const ro = await who(clients.realOwner), rr = await who(clients.realRuntime);
    const to = await who(clients.testOwner), tr = await who(clients.testRuntime);
    console.log("Connections:");
    console.log(`  real DB  owner   -> ${ro.u} @ ${ro.d}`);
    console.log(`  real DB  runtime -> ${rr.u} @ ${rr.d}`);
    console.log(`  test DB  owner   -> ${to.u} @ ${to.d}`);
    console.log(`  test DB  runtime -> ${tr.u} @ ${tr.d}\n`);
    add("test connections use a different database from the real one", to.d !== ro.d && tr.d !== rr.d && to.d === tr.d);
    add("test connections use a database whose name ends in _test", /_test$/.test(to.d) && /_test$/.test(tr.d), `${to.d}`);
    add("real connections use the real database (name does not end in _test)", !/_test$/.test(ro.d) && !/_test$/.test(rr.d), `${ro.d}`);

    await staticChecks("real", clients.realOwner, rr.u, ro.u);
    await staticChecks("test", clients.testOwner, tr.u, to.u);
    await futureTableProbe(clients.testOwner, tr.u, to.u);
  } finally {
    await Promise.all(Object.values(clients).map((c) => c.end()));
  }

  let failed = 0;
  for (const r of rows) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  [${r.detail}]` : ""}`);
  }
  if (notes.length) console.log("\n" + notes.join("\n"));
  console.log(failed === 0 ? `\nAll ${rows.length} checks passed.` : `\n${failed} of ${rows.length} checks FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error("Verification could not run:", e.message); process.exit(2); });