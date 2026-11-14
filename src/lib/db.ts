import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// The app's ONLY database connection. It uses DATABASE_URL, which env.ts requires to be the
// restricted hr_runtime account (never the owner account).

export type Db = PrismaClient;

// Builds a client for a given address. Tests use this with the disposable test database.
export function createDb(connectionString: string): Db {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    }),
  });
}

// One shared client for the whole server process. During development Next.js reloads code
// often; keeping the client on globalThis stops it from opening a new set of connections each time.
// It is created on first use (not at import time) so a build never needs database settings.
const globalForDb = globalThis as unknown as { __hrDb?: Db };

export function getDb(): Db {
  globalForDb.__hrDb ??= createDb(getEnv().DATABASE_URL);
  return globalForDb.__hrDb;
}
