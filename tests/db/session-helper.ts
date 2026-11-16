// Real sessions for database tests.
//
// Row-level security takes "who is asking" from a LIVE session that the database looks up itself (see the
// security_hardening migration): a context object made up by a test is not enough any more, exactly as a
// user id made up by the application is not enough. These helpers create a real session row (through the
// owner connection, like the other fixtures) and link its token to the test's context object.
import { bindSessionToken } from "@/lib/auth/session-binding";
import type { Db } from "@/lib/db";
import { generateSessionToken, hashToken } from "@/lib/security/tokens";

// Removes the audit records of throw-away test organisations so the organisations (and their users) can be
// deleted afterwards. The audit log is append-only for everyone, the owner included, and since the
// security_hardening migration the DATABASE writes some audit records itself (a public application, an
// accepted invitation), so a test can no longer swap in a recorder for those. Only on the disposable test
// database: this refuses to run anywhere else. One transaction: the protection is off only inside it.
export async function purgeTestAuditRows(owner: Db, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  await owner.$transaction(async (tx) => {
    const [{ name }] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/_test$/.test(name)) throw new Error(`purgeTestAuditRows: refusing to run on "${name}"`);
    await tx.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"`);
    await tx.$executeRaw`DELETE FROM "audit_logs" WHERE "organization_id"::text = ANY(${organizationIds})`;
    await tx.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"`);
  });
}

// A live session for this user in this organisation. Returns the raw token (what the browser cookie holds).
export async function createTestSession(owner: Db, userId: string, organizationId: string | null): Promise<string> {
  const token = generateSessionToken();
  const now = new Date(); // the database checks the deadlines against its own clock
  await owner.session.create({
    data: {
      userId,
      activeOrganizationId: organizationId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
      lastSeenAt: now,
      createdAt: now,
    },
  });
  return token;
}

// Links a hand-built context to a real session of its user and organisation. Returns the same object.
export async function giveSession<T extends { user: { id: string }; organization: { id: string } | null }>(owner: Db, ctx: T): Promise<T> {
  bindSessionToken(ctx, await createTestSession(owner, ctx.user.id, ctx.organization?.id ?? null));
  return ctx;
}

// The same for tests that talk to PostgreSQL directly (pg client, owner connection). One session per
// (user, organisation), reused. Returns the raw token for set_config('app.session_token', ...).
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
const pgTokens = new Map<string, Promise<string>>();
export function pgSessionToken(owner: Queryable, userId: string, organizationId: string | null): Promise<string> {
  const key = `${userId}|${organizationId ?? ""}`;
  let token = pgTokens.get(key);
  if (!token) {
    token = (async () => {
      const raw = generateSessionToken();
      await owner.query(
        `INSERT INTO sessions (id, user_id, active_organization_id, token_hash, expires_at, absolute_expires_at, last_seen_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '1 hour', now() + interval '12 hours', now(), now())`,
        [userId, organizationId, hashToken(raw)],
      );
      return raw;
    })();
    pgTokens.set(key, token);
  }
  return token;
}

// The statement that says "a signed-in member is asking" in raw SQL tests.
export const STAFF_CONTEXT_SQL = `SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`;
