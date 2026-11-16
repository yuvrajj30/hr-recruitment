import "server-only";
import type { Db } from "@/lib/db";
import type { SessionTimings } from "./config";
import { ForbiddenError } from "./errors";
import type { PermissionKey } from "./permission-keys";
import { type Access, loadAccess, NO_ACCESS } from "./permissions";
import { bindSessionToken } from "./session-binding";
import { type SessionDb, type SessionFailure, type SessionPrincipal, validateSession } from "./session-store";

// "Who is asking, in which organization, and what may they do?" - built fresh for every request.
// Routes and pages get one of these and pass it to every data function.

export type AuthContext = SessionPrincipal & Access;

export type ContextResult = { ok: true; ctx: AuthContext } | { ok: false; reason: SessionFailure };

export async function getAuthContext(
  db: SessionDb & Pick<Db, "organizationMemberRole">,
  token: string | null | undefined,
  opts: { now: Date; timings: SessionTimings; touch: boolean },
): Promise<ContextResult> {
  const result = await validateSession(db, token, opts);
  if (!result.ok) return result;
  const { principal } = result;
  // No membership means no permissions. Being a "platform admin" gives no access to any company's data.
  const access = principal.memberId ? await loadAccess(db, principal.memberId) : NO_ACCESS;
  const ctx: AuthContext = { ...principal, ...access };
  // The database works out who is asking from this session (never from an id the app states): see db-context.ts.
  bindSessionToken(ctx, token as string);
  return { ok: true, ctx };
}

// The organization every database query must be limited to. It comes from the server-side session,
// never from the URL, a header or the request body.
export function requireOrganizationId(ctx: AuthContext): string {
  if (!ctx.organization) throw new ForbiddenError("no active organization");
  return ctx.organization.id;
}

export function requirePermission(ctx: AuthContext, key: PermissionKey): void {
  if (!ctx.permissions.has(key)) throw new ForbiddenError(`missing permission ${key}`);
}

// Passes if the person has AT LEAST ONE of the listed permissions.
export function requireAnyPermission(ctx: AuthContext, keys: readonly PermissionKey[]): void {
  if (!keys.some((k) => ctx.permissions.has(k))) throw new ForbiddenError(`missing one of ${keys.join(", ")}`);
}

// Adds the organization filter to a query's "where". The organization is applied LAST, so nothing
// the caller passes in (even by mistake) can point the query at a different organization.
//   db.job.findMany({ where: scopedToOrganization(ctx, { status: "OPEN" }) })
export function scopedToOrganization<T extends object>(ctx: AuthContext, where: T): T & { organizationId: string } {
  return { ...where, organizationId: requireOrganizationId(ctx) };
}
