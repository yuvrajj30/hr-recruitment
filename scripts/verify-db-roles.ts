// Read-only check: is hr_app the owner and hr_runtime properly restricted?
// Usage (PowerShell, from the project folder):  npx tsx scripts/verify-db-roles.ts
// It only READS permission information. It never tries a destructive action.
import "dotenv/config";
import { Client } from "pg";

type Row = { check: string; ok: boolean; detail?: string };
const rows: Row[] = [];
const add = (check: string, ok: boolean, detail?: string) => rows.push({ check, ok, detail });

async function main() {
  const runtimeUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!runtimeUrl || !ownerUrl) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL must both be set in .env");
  const ownerRole = process.env.DB_OWNER_ROLE ?? "hr_app";

  const owner = new Client({ connectionString: ownerUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  await owner.connect();
  await runtime.connect();
  try {
    const who = async (c: Client) => (await c.query("SELECT current_user AS u")).rows[0].u as string;
    const ownerName = await who(owner);
    const runtimeName = await who(runtime);
    add("migration account is the owner account", ownerName === ownerRole, ownerName);
    add("runtime account is a different account", runtimeName !== ownerName, runtimeName);

    const tables = (await owner.query(
      "SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'",
    )).rows as { name: string; owner: string }[];
    add("every table is owned by the owner account", tables.every((t) => t.owner === ownerName), `${tables.length} tables`);
    add("runtime account owns no tables", !tables.some((t) => t.owner === runtimeName));

    const attr = (await owner.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname=$1", [runtimeName])).rows[0];
    add("runtime is not a superuser", attr && !attr.rolsuper);
    add("runtime cannot create databases or roles", attr && !attr.rolcreatedb && !attr.rolcreaterole);
    add("runtime cannot replicate or bypass row-level security", attr && !attr.rolreplication && !attr.rolbypassrls);

    const priv = async (table: string, p: string) =>
      (await runtime.query("SELECT has_table_privilege(current_user, $1, $2) AS v", [`public."${table}"`, p])).rows[0].v as boolean;

    const names = tables.map((t) => t.name);
    const canTruncate: string[] = [];
    for (const n of names) if (await priv(n, "TRUNCATE")) canTruncate.push(n);
    add("runtime cannot TRUNCATE any table", canTruncate.length === 0, canTruncate.join(", "));
    const canAlter: string[] = [];
    for (const n of names) if ((await priv(n, "TRIGGER")) || (await priv(n, "REFERENCES"))) canAlter.push(n);
    add("runtime has no TRIGGER/REFERENCES rights", canAlter.length === 0, canAlter.join(", "));

    for (const t of ["audit_logs", "integration_sync_errors", "application_status_history"]) {
      add(`runtime cannot UPDATE or DELETE ${t}`, !(await priv(t, "UPDATE")) && !(await priv(t, "DELETE")));
      add(`runtime can still read and add to ${t}`, (await priv(t, "SELECT")) && (await priv(t, "INSERT")));
    }
    if (names.includes("_prisma_migrations")) {
      add("runtime has no access to _prisma_migrations", !(await priv("_prisma_migrations", "SELECT")) && !(await priv("_prisma_migrations", "INSERT")));
    }
    const normal = ["users", "sessions", "organizations", "job_openings"].filter((n) => names.includes(n));
    for (const t of normal) add(`runtime can read and write ${t}`, (await priv(t, "SELECT")) && (await priv(t, "INSERT")) && (await priv(t, "UPDATE")) && (await priv(t, "DELETE")));

    const schema = (await runtime.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS c")).rows[0].c as boolean;
    add("runtime cannot create objects in the public schema", !schema);
    const db = (await runtime.query("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS c")).rows[0].c as boolean;
    add("runtime cannot create schemas in the database", !db);
  } finally {
    await owner.end();
    await runtime.end();
  }

  let failed = 0;
  for (const r of rows) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  [${r.detail}]` : ""}`);
  }
  console.log(failed === 0 ? `\nAll ${rows.length} checks passed.` : `\n${failed} of ${rows.length} checks FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error("Verification could not run:", e.message); process.exit(2); });
