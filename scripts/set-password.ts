// Sets a new password for ONE existing account. For recovery when a password is forgotten.
// Usage (PowerShell, from the project folder):
//     npm run auth:set-password -- someone@example.com
//
// What it does, and nothing else:
//   1. asks for the new password (hidden typing, twice) and checks that it is strong enough
//   2. saves only the password's scrambled form (hash) for that one account
//   3. signs that account out everywhere (all its sessions end)
//   4. clears that email's recent failed sign-in attempts, so a lockout does not block the new password
//   5. writes one record to the audit log
// It never prints or stores the password. It uses the owner connection (MIGRATION_DATABASE_URL).
import "dotenv/config";
import { writeAudit } from "@/lib/auth/audit";
import { revokeAllSessionsForUser } from "@/lib/auth/session-store";
import { createDb } from "@/lib/db";
import { hashPassword, validateNewPassword } from "@/lib/security/password";
import { hashIdentifier } from "@/lib/security/tokens";

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(1); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function askNewPassword(avoid: string[]): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await askHidden("New password (typing is hidden): ");
    const check = validateNewPassword(first, avoid);
    if (!check.ok) {
      console.log(`  ${check.reason}`);
      continue;
    }
    const second = await askHidden("Type it again to confirm: ");
    if (first !== second) {
      console.log("  The two entries did not match. Try again.");
      continue;
    }
    return first;
  }
  throw new Error("No password was set after 3 attempts. Nothing was changed.");
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Give the account's email address, e.g.  npm run auth:set-password -- someone@example.com");
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const secret = process.env.AUTH_SECRET;
  if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL is missing from .env");
  if (!secret) throw new Error("AUTH_SECRET is missing from .env");

  const db = createDb(ownerUrl, { max: 2 });
  try {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, status: true } });
    if (!user) throw new Error(`No account exists for ${email}. Nothing was changed.`);
    console.log(`Account found: ${user.name} <${email}> (${user.status})`);
    console.log("This will set a new password, sign this account out everywhere, and add one audit record.");

    const password = await askNewPassword([email, user.name]);
    const passwordHash = await hashPassword(password);
    const now = new Date();

    const ended = await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      const count = await revokeAllSessionsForUser(tx, user.id, "password_changed", now);
      await tx.authLoginAttempt.deleteMany({ where: { identifierHash: hashIdentifier(email, secret) } });
      await writeAudit(tx, {
        organizationId: null,
        actorUserId: null,
        action: "auth.password_set_by_operator",
        entityType: "user",
        entityId: user.id,
        metadata: { method: "command_line_script", signedOutEverywhere: count },
        ipAddress: null,
        userAgent: null,
        now,
      });
      return count;
    });
    console.log(`Done. New password saved. ${ended} session(s) ended. You can sign in now.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  // Show our own plain messages; for anything unexpected show only the error type (never details).
  const ours = error instanceof Error && /^(Give the account|MIGRATION_DATABASE_URL|AUTH_SECRET|No account|No password)/.test(error.message);
  console.error(ours ? error.message : `Failed (${error instanceof Error ? error.name : "unknown error"}). Nothing was changed.`);
  process.exit(1);
});
