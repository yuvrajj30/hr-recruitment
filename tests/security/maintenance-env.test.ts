// The maintenance account's password must reach the scheduled job only, never the web app (see the
// maintenance_identity migration and prisma/sql/m4-01-create-maintenance-role.sql).
import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/lib/env";
import { maintenanceSecretsIn, parseMaintenanceEnv } from "../../src/lib/maintenance-env";

const web = {
  DATABASE_URL: "postgresql://hr_runtime:pw@localhost:5432/hr_recruitment",
  MIGRATION_DATABASE_URL: "postgresql://hr_app:pw@localhost:5432/hr_recruitment",
  AUTH_SECRET: "x".repeat(40),
  APP_ORIGIN: "http://localhost:3000",
};
const maintUrl = "postgresql://hr_maintenance:secret-pw@localhost:5432/hr_recruitment";

describe("web app settings and the maintenance account", () => {
  it("refuses to start the web app when it is given the maintenance account's connection", () => {
    expect(() => parseEnv({ ...web, MAINTENANCE_DATABASE_URL: maintUrl })).toThrow(/MAINTENANCE_DATABASE_URL/);
  });
  it("refuses to run the web app as the maintenance account", () => {
    expect(() => parseEnv({ ...web, DATABASE_URL: maintUrl })).toThrow(/maintenance account/);
  });
  it("never prints the maintenance password", () => {
    try {
      parseEnv({ ...web, MAINTENANCE_DATABASE_URL: maintUrl });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-pw");
    }
  });
});

describe("scheduled job settings", () => {
  it("needs the maintenance account's connection", () => {
    expect(() => parseMaintenanceEnv({})).toThrow(/MAINTENANCE_DATABASE_URL/);
    expect(parseMaintenanceEnv({ MAINTENANCE_DATABASE_URL: maintUrl }).MAINTENANCE_DATABASE_URL).toBe(maintUrl);
  });
  it("refuses any other account than the maintenance account", () => {
    for (const user of ["hr_runtime", "hr_app", "postgres"]) {
      expect(() => parseMaintenanceEnv({ MAINTENANCE_DATABASE_URL: `postgresql://${user}:pw@localhost:5432/hr_recruitment` }), user).toThrow(/hr_maintenance/);
    }
    expect(parseMaintenanceEnv({ MAINTENANCE_DATABASE_URL: "postgresql://hr_jobs:pw@h:5432/d", DB_MAINTENANCE_ROLE: "hr_jobs" }).DB_MAINTENANCE_ROLE).toBe("hr_jobs");
    expect(() => parseMaintenanceEnv({ MAINTENANCE_DATABASE_URL: "postgresql://hr_app:pw@h:5432/d", DB_MAINTENANCE_ROLE: "hr_app" })).toThrow(/owner/);
  });
  it("never prints the password", () => {
    try {
      parseMaintenanceEnv({ MAINTENANCE_DATABASE_URL: "postgresql://hr_runtime:secret-pw@localhost:5432/hr_recruitment" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-pw");
    }
  });
  it("finds the maintenance connection in a settings file the web app also reads", () => {
    expect(maintenanceSecretsIn({ DATABASE_URL: "x", MAINTENANCE_DATABASE_URL: maintUrl })).toEqual(["MAINTENANCE_DATABASE_URL"]);
    expect(maintenanceSecretsIn({ DATABASE_URL: "x" })).toEqual([]);
  });
});
