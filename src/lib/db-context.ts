import "server-only";
import { sessionTokenOf } from "@/lib/auth/session-binding";
import type { Db } from "@/lib/db";

// Tells PostgreSQL WHO is asking, so its row-level security policies (see the row_level_security
// migration) can decide what each query may see or change.
//
//   const db = staffDb(getAuthRuntime().db, ctx);   // a signed-in member of an organisation
//   const db = publicApplyDb(getAuthRuntime().db);   // the public careers pages
//
// The returned client is used exactly like the normal one. Behind the scenes every query runs inside a
// transaction that first records who is asking with set_config(..., true): the settings vanish when that
// transaction ends, so nothing leaks between requests or pooled connections.
//   - staff:  `app.mode` = 'staff' and `app.session_token` = the person's session token. The DATABASE looks the
//             session up (it stores only the token's fingerprint) and takes the user and organisation from it.
//             A user id or organisation stated by the application is not read at all, so it cannot be forged.
//   - public: `app.mode` = 'public_apply' and `app.org_id` = the job's organisation (anonymous by nature).
//   - a single query            -> a small two-step transaction: [set_config, the query]
//   - db.$transaction(fn)       -> one transaction: set_config first, then everything fn does
//   - db.$transaction([a, b])   -> one transaction: [set_config, a, b]
// The member's ROLE is not sent: the database looks it up from the active membership itself.

export type DbContext =
  | { mode: "staff"; sessionToken: string }
  | { mode: "public_apply"; organizationId: string | null };

type Scoped = { base: Db; context: DbContext };
const SCOPES = new WeakMap<object, Scoped>();

// The client underneath a context-bound one (or the client itself).
export const baseDb = (db: Db): Db => SCOPES.get(db)?.base ?? db;
export const dbContextOf = (db: Db): DbContext | null => SCOPES.get(db)?.context ?? null;

type RawCapable = Pick<Db, "$executeRaw">;
const setContext = (client: RawCapable, c: DbContext) =>
  client.$executeRaw`SELECT set_config('app.mode', ${c.mode}, true),
                            set_config('app.session_token', ${c.mode === "staff" ? c.sessionToken : ""}, true),
                            set_config('app.org_id', ${c.mode === "public_apply" ? (c.organizationId ?? "") : ""}, true)`;

export function withDbContext(db: Db, context: DbContext): Db {
  const base = baseDb(db);
  const models = new Map<string | symbol, unknown>();

  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (arg: unknown, options?: unknown) => {
          if (typeof arg === "function") {
            // Interactive transaction: the context is set first, then the caller's work runs on the plain
            // transaction client (already inside the context, so nothing needs wrapping).
            return target.$transaction(async (tx) => {
              await setContext(tx as unknown as RawCapable, context);
              return (arg as (tx: unknown) => Promise<unknown>)(tx);
            }, options as Parameters<Db["$transaction"]>[1]);
          }
          const list = arg as ReturnType<RawCapable["$executeRaw"]>[];
          return target.$transaction([setContext(target, context), ...list], options as never).then((r: unknown[]) => r.slice(1));
        };
      }
      if (prop === "$queryRaw" || prop === "$executeRaw" || prop === "$queryRawUnsafe" || prop === "$executeRawUnsafe") {
        return (...args: unknown[]) =>
          target.$transaction(async (tx) => {
            await setContext(tx as unknown as RawCapable, context);
            return (tx[prop as "$queryRaw"] as (...a: unknown[]) => unknown)(...args);
          });
      }
      const value = Reflect.get(target, prop, target) as unknown;
      // Model delegates (db.jobOpening, db.application, ...): each call runs in [set_config, the query].
      if (typeof prop === "string" && !prop.startsWith("$") && value && typeof value === "object" && "findMany" in (value as object)) {
        let wrapped = models.get(prop);
        if (!wrapped) {
          const delegate = value as Record<string, unknown>;
          wrapped = new Proxy(delegate, {
            get(d, method) {
              const fn = Reflect.get(d, method, d);
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) =>
                target.$transaction([setContext(target, context), (fn as (...a: unknown[]) => never).apply(d, args)]).then((r: unknown[]) => r[1]);
            },
          });
          models.set(prop, wrapped);
        }
        return wrapped;
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  SCOPES.set(proxy, { base, context });
  return proxy;
}

// A signed-in member, in the organisation of their session.
// `ctx` must be the context object that getAuthContext() returned for this request (not a copy of it).
export function staffDb(db: Db, ctx: object): Db {
  const sessionToken = sessionTokenOf(ctx);
  if (!sessionToken) throw new Error("staffDb: this context is not linked to a session");
  return withDbContext(db, { mode: "staff", sessionToken });
}

// The public careers pages. Before the job is known only published public jobs are readable; once it is
// known, narrow it to that job's organisation to submit the application.
export function publicApplyDb(db: Db, organizationId: string | null = null): Db {
  return withDbContext(db, { mode: "public_apply", organizationId });
}
