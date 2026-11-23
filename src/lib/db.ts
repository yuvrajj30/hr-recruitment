import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// The app's ONLY database connection. It uses DATABASE_URL, which env.ts requires to be the
// restricted hr_runtime account (never the owner account).

export type Db = PrismaClient;

// Builds a client for a given address. Tests use this with the disposable test database.
//
// sessionTimeZone: the PostgreSQL session time zone for every connection.
//   "UTC" (the default here) - required for correct timestamps: the Prisma pg adapter sends and reads
//          timestamptz values WITHOUT their offset, so any other session time zone shifts them (stored
//          values move by the zone's offset, and database-generated times are read back shifted).
//   null  - leave the server's own setting (legacy behaviour; the server is configured for Asia/Calcutta).
// The running app chooses via DB_SESSION_TIME_ZONE (see getDb), so the switch to UTC for an existing
// database happens only together with the reviewed correction of its historical timestamps.
export function createDb(connectionString: string, options: { max?: number; sessionTimeZone?: "UTC" | null } = {}): Db {
  const timeZone = options.sessionTimeZone === undefined ? "UTC" : options.sessionTimeZone;
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ...(timeZone ? { options: `-c TimeZone=${timeZone}` } : {}),
    }),
  });
}

// One shared client for the whole server process. During development Next.js reloads code
// often; keeping the client on globalThis stops it from opening a new set of connections each time.
// It is created on first use (not at import time) so a build never needs database settings.
const globalForDb = globalThis as unknown as { __hrDb?: Db };

export function getDb(): Db {
  const env = getEnv();
  globalForDb.__hrDb ??= createDb(env.DATABASE_URL, { sessionTimeZone: env.DB_SESSION_TIME_ZONE ?? null });
  return globalForDb.__hrDb;
}
