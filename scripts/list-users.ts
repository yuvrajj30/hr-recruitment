// READ-ONLY. Lists the accounts in the database so you can see which email to sign in with,
// and whether each account is able to sign in. It changes nothing and never shows password data.
// Usage (PowerShell, from the project folder):  npm run auth:list-users
import "dotenv/config";
import { Client } from "pg";

type Row = {
  email: string;
  name: string;
  status: string;
  is_platform_admin: boolean;
  has_password: boolean;
  org_slug: string | null;
  member_status: string | null;
  org_status: string | null;
};

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is missing from .env");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<Row>(`
      SELECT u.email, u.name, u.status::text AS status, u.is_platform_admin,
             (u.password_hash IS NOT NULL) AS has_password,
             o.slug AS org_slug, m.status::text AS member_status, o.status::text AS org_status
      FROM users u
      LEFT JOIN organization_members m ON m.user_id = u.id
      LEFT JOIN organizations o ON o.id = m.organization_id
      ORDER BY u.created_at, o.slug`);
    if (rows.length === 0) console.log("There are no accounts in this database.");
    for (const r of rows) {
      const memberOk = r.member_status === "ACTIVE" && r.org_status === "ACTIVE";
      const canSignIn = r.status === "ACTIVE" && r.has_password && memberOk;
      console.log(`${r.email}  (${r.name})`);
      console.log(`    account: ${r.status} | password set: ${r.has_password ? "yes" : "NO"} | platform admin: ${r.is_platform_admin ? "yes" : "no"}`);
      console.log(`    organization: ${r.org_slug ?? "none"} | membership: ${r.member_status ?? "none"} | organization status: ${r.org_status ?? "none"}`);
      console.log(`    can sign in: ${canSignIn ? "YES" : "NO"}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error && error.message.startsWith("MIGRATION_DATABASE_URL") ? error.message : `Failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
});
