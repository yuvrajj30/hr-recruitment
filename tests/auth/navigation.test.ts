import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@/lib/auth/permission-keys";
import { ROLE_PERMISSIONS } from "@/lib/auth/roles";
import { buildNavigation, isActivePath, NAV_ITEMS } from "@/lib/navigation";

const perms = (...keys: string[]) => new Set(keys);

describe("navigation", () => {
  it("lists all 15 modules in the agreed order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Dashboard", "Employees", "Recruitment", "Interviews", "Attendance", "Leave Management", "Tasks", "Onboarding",
      "Performance", "Form Builder", "Reports and Analytics", "Announcements", "Organisation Settings",
      "User and Role Management", "Integrations",
    ]);
  });
  it("shows only released modules: today the dashboard, employees, recruitment, interviews, attendance, leave, tasks, reports and user management, even for someone with every permission", () => {
    const everything = perms(...NAV_ITEMS.flatMap((i) => (i.requiresAny === "everyone" ? [] : [...i.requiresAny])));
    expect(buildNavigation(everything).map((i) => i.key)).toEqual(["dashboard", "employees", "recruitment", "interviews", "attendance", "leave", "tasks", "reports", "users"]);
    expect(buildNavigation(perms()).map((i) => i.key)).toEqual(["dashboard"]);
  });
  it("shows recruitment to people who can read jobs or applications, and to nobody else", () => {
    expect(buildNavigation(perms("job:read")).map((i) => i.key)).toEqual(["dashboard", "recruitment"]);
    expect(buildNavigation(perms("application:read")).map((i) => i.key)).toEqual(["dashboard", "recruitment"]);
    expect(buildNavigation(new Set(ROLE_PERMISSIONS.EMPLOYEE)).map((i) => i.key)).toEqual(["dashboard", "attendance", "leave", "tasks"]);
    expect(buildNavigation(new Set(ROLE_PERMISSIONS.HR_MANAGER)).map((i) => i.key)).toEqual(["dashboard", "employees", "recruitment", "interviews", "attendance", "leave", "tasks", "reports", "users"]);
    expect(buildNavigation(perms("report:read")).map((i) => i.key)).toEqual(["dashboard", "reports"]);
    expect(buildNavigation(perms("employee:read")).map((i) => i.key)).toEqual(["dashboard", "employees"]);
    expect(buildNavigation(perms("interview:read")).map((i) => i.key)).toEqual(["dashboard", "interviews"]);
  });
  it("only ever asks for permissions that exist", () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const item of NAV_ITEMS) if (item.requiresAny !== "everyone") for (const p of item.requiresAny) expect(known.has(p), `${item.key}: ${p}`).toBe(true);
  });
  it("once modules ship, each of the three roles sees only its own areas", () => {
    const shipped = NAV_ITEMS.map((i) => ({ ...i, status: "available" as const }));
    const keys = (role: keyof typeof ROLE_PERMISSIONS) => buildNavigation(new Set(ROLE_PERMISSIONS[role]), shipped).map((i) => i.key);
    expect(keys("EMPLOYEE")).toEqual(["dashboard", "attendance", "leave", "tasks", "performance", "announcements"]);
    expect(keys("HR_MANAGER")).not.toContain("settings");
    expect(keys("HR_MANAGER")).not.toContain("integrations");
    expect(keys("HR_MANAGER")).toEqual(expect.arrayContaining(["employees", "recruitment", "interviews", "attendance", "leave", "tasks", "users", "reports"]));
    expect(keys("SUPER_ADMIN")).toHaveLength(NAV_ITEMS.length);
  });
  it("sends the browser no permission information", () => {
    const [item] = buildNavigation(perms("org:update"));
    expect(Object.keys(item!).sort()).toEqual(["href", "key", "label", "section"]);
  });
  it("marks the current page, including its sub-pages, but not look-alike paths", () => {
    expect(isActivePath("/dashboard", "/dashboard")).toBe(true);
    expect(isActivePath("/dashboard/x", "/dashboard")).toBe(true);
    expect(isActivePath("/dashboards", "/dashboard")).toBe(false);
    expect(isActivePath("/", "/dashboard")).toBe(false);
  });
});
