import { describe, expect, it } from "vitest";
import { buildNavigation, isActivePath, NAV_ITEMS } from "@/lib/navigation";

const perms = (...keys: string[]) => new Set(keys);

describe("navigation", () => {
  it("lists all 14 modules in the agreed order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Dashboard", "Employees", "Recruitment", "Interviews", "Attendance", "Leave Management", "Onboarding",
      "Performance", "Form Builder", "Reports and Analytics", "Announcements", "Organisation Settings",
      "User and Role Management", "Integrations",
    ]);
  });
  it("shows only released modules: today the dashboard and recruitment, even for someone with every permission", () => {
    const everything = perms(...NAV_ITEMS.flatMap((i) => (i.requiresAny === "everyone" ? [] : [...i.requiresAny])));
    expect(buildNavigation(everything).map((i) => i.key)).toEqual(["dashboard", "recruitment"]);
    expect(buildNavigation(perms()).map((i) => i.key)).toEqual(["dashboard"]);
  });
  it("shows recruitment to people who can read jobs or applications, and to nobody else", () => {
    expect(buildNavigation(perms("job:read")).map((i) => i.key)).toEqual(["dashboard", "recruitment"]);
    expect(buildNavigation(perms("application:read_assigned")).map((i) => i.key)).toEqual(["dashboard", "recruitment"]);
    expect(buildNavigation(perms("interview:read_assigned", "feedback:submit")).map((i) => i.key)).toEqual(["dashboard"]);
  });
  it("once a module ships, shows it only to people with one of its permissions", () => {
    const shipped = NAV_ITEMS.map((i) => ({ ...i, status: "available" as const }));
    const interviewer = buildNavigation(perms("interview:read_assigned", "feedback:submit"), shipped).map((i) => i.key);
    expect(interviewer).toEqual(["dashboard", "interviews", "announcements"]);
    const admin = buildNavigation(perms("org:update", "member:read", "integration:read"), shipped).map((i) => i.key);
    expect(admin).toEqual(["dashboard", "announcements", "settings", "users", "integrations"]);
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
