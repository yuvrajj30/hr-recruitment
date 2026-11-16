import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AuthContext,
  requireAnyPermission,
  requireOrganizationId,
  requirePermission,
  scopedToOrganization,
} from "@/lib/auth/context";
import { AuthError, ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";
import { PERMISSION_KEYS } from "@/lib/auth/permission-keys";
import { hasAnyPermission, hasPermission, readScope } from "@/lib/auth/permissions";

const ctxWith = (perms: string[], organization: AuthContext["organization"] = { id: "org-1", name: "Org One", slug: "org-one" }): AuthContext => ({
  sessionId: "s1",
  user: { id: "u1", email: "a@example.test", name: "A", isPlatformAdmin: false },
  organization,
  memberId: organization ? "m1" : null,
  expiresAt: new Date(),
  absoluteExpiresAt: new Date(),
  roleKeys: [],
  permissions: new Set(perms),
});

describe("the permission list matches the database seed", () => {
  it("has no duplicates and the expected 62 permissions", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    expect(PERMISSION_KEYS).toHaveLength(62);
  });
  it("is exactly the set of permissions that prisma/seed.ts creates", () => {
    const seed = readFileSync("prisma/seed.ts", "utf8");
    // Permission entries look like  ["job:read", "View job openings"]  (role lists use bare strings).
    const inSeed = [...seed.matchAll(/\["([a-z_]+:[a-z_]+)",\s*"/g)].map((m) => m[1]).sort();
    expect(inSeed.length).toBeGreaterThan(0);
    expect([...PERMISSION_KEYS].sort()).toEqual(inSeed);
  });
});

describe("read scope", () => {
  it("is all-or-nothing: there is no 'assigned only' level with the three roles", () => {
    expect(readScope(new Set(["candidate:read"]), "candidate")).toBe("all");
    expect(readScope(new Set(["candidate:read_assigned"]), "candidate")).toBe("none");
    expect(readScope(new Set(["interview:read_assigned"]), "interview")).toBe("none");
  });
  it("one resource never grants another", () => {
    expect(readScope(new Set(), "application")).toBe("none");
    expect(readScope(new Set(["candidate:read"]), "application")).toBe("none");
    expect(readScope(new Set(["application:create"]), "application")).toBe("none");
  });
});

describe("permission checks", () => {
  const perms = new Set(["job:read", "job:create"]);
  it("hasPermission / hasAnyPermission", () => {
    expect(hasPermission(perms, "job:create")).toBe(true);
    expect(hasPermission(perms, "job:delete")).toBe(false);
    expect(hasAnyPermission(perms, ["job:delete", "job:read"])).toBe(true);
    expect(hasAnyPermission(perms, ["job:delete", "org:update"])).toBe(false);
    expect(hasAnyPermission(perms, [])).toBe(false);
  });
  it("requirePermission passes silently or throws a 403", () => {
    const ctx = ctxWith(["job:create"]);
    expect(() => requirePermission(ctx, "job:create")).not.toThrow();
    expect(() => requirePermission(ctx, "job:delete")).toThrow(ForbiddenError);
  });
  it("requireAnyPermission needs at least one match", () => {
    const ctx = ctxWith(["job:read"]);
    expect(() => requireAnyPermission(ctx, ["job:delete", "job:read"])).not.toThrow();
    expect(() => requireAnyPermission(ctx, ["job:delete", "org:update"])).toThrow(ForbiddenError);
  });
  it("the error is a generic 403 and its message does not reveal what was missing", () => {
    try {
      requirePermission(ctxWith([]), "org:update");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      const err = e as ForbiddenError;
      expect(err.status).toBe(403);
      expect(err.code).toBe("forbidden");
      expect(err.message).toBe("forbidden");
      expect(err.detail).toContain("org:update"); // kept for the server log only
    }
  });
  it("UnauthorizedError is a 401", () => {
    const e = new UnauthorizedError();
    expect([e.status, e.code, e.message]).toEqual([401, "unauthorized", "unauthorized"]);
  });
  it("a platform admin flag alone grants nothing", () => {
    const ctx = { ...ctxWith([]), user: { id: "p", email: "p@example.test", name: "P", isPlatformAdmin: true } };
    expect(() => requirePermission(ctx, "job:read")).toThrow(ForbiddenError);
  });
});

describe("organization scoping", () => {
  it("returns the organization of the session", () => {
    expect(requireOrganizationId(ctxWith([]))).toBe("org-1");
  });
  it("refuses when the session has no organization", () => {
    const ctx = ctxWith([], null);
    expect(() => requireOrganizationId(ctx)).toThrow(ForbiddenError);
    expect(() => scopedToOrganization(ctx, {})).toThrow(ForbiddenError);
  });
  it("adds the organization to a filter", () => {
    expect(scopedToOrganization(ctxWith([]), { status: "OPEN" })).toEqual({ status: "OPEN", organizationId: "org-1" });
  });
  it("cannot be overridden by what the caller passes in", () => {
    const where = scopedToOrganization(ctxWith([]), { organizationId: "someone-elses-org", status: "OPEN" });
    expect(where.organizationId).toBe("org-1");
  });
});
