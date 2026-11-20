// The sidebar, decided in one place and tested.
//
// An item is shown only when BOTH are true:
//   1. its module has been released (status "available"), and
//   2. the signed-in person holds at least one of its permissions.
// Planned modules are listed here so the order and wording are agreed, but they stay hidden until
// they ship: the sidebar never links to a page that does not exist.
// Hiding an item is only about tidiness. Every page and action still checks permissions on the server.

export type NavIcon =
  | "dashboard"
  | "employees"
  | "recruitment"
  | "interviews"
  | "attendance"
  | "leave"
  | "onboarding"
  | "performance"
  | "forms"
  | "reports"
  | "announcements"
  | "settings"
  | "users"
  | "integrations";

export type NavSection = "workspace" | "administration";

type NavItemDefinition = {
  key: NavIcon;
  label: string;
  href: string;
  section: NavSection;
  status: "available" | "planned";
  requiresAny: readonly string[] | "everyone";
};

export const NAV_ITEMS: readonly NavItemDefinition[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", section: "workspace", status: "available", requiresAny: "everyone" },
  { key: "employees", label: "Employees", href: "/employees", section: "workspace", status: "available", requiresAny: ["employee:read"] },
  { key: "recruitment", label: "Recruitment", href: "/recruitment", section: "workspace", status: "available", requiresAny: ["job:read", "application:read"] },
  { key: "interviews", label: "Interviews", href: "/interviews", section: "workspace", status: "available", requiresAny: ["interview:read"] },
  { key: "attendance", label: "Attendance", href: "/attendance", section: "workspace", status: "planned", requiresAny: ["self:attendance_read", "attendance:read"] },
  { key: "leave", label: "Leave Management", href: "/leave", section: "workspace", status: "planned", requiresAny: ["self:leave_apply", "leave:read"] },
  { key: "onboarding", label: "Onboarding", href: "/onboarding", section: "workspace", status: "planned", requiresAny: ["onboarding:read"] },
  { key: "performance", label: "Performance", href: "/performance", section: "workspace", status: "planned", requiresAny: ["self:profile_read", "employee:read"] },
  { key: "forms", label: "Form Builder", href: "/forms", section: "workspace", status: "planned", requiresAny: ["form:read"] },
  { key: "reports", label: "Reports and Analytics", href: "/reports", section: "workspace", status: "planned", requiresAny: ["report:read"] },
  { key: "announcements", label: "Announcements", href: "/announcements", section: "workspace", status: "planned", requiresAny: "everyone" },
  { key: "settings", label: "Organisation Settings", href: "/settings", section: "administration", status: "planned", requiresAny: ["org:update"] },
  { key: "users", label: "User and Role Management", href: "/users", section: "administration", status: "available", requiresAny: ["user:read"] },
  { key: "integrations", label: "Integrations", href: "/integrations", section: "administration", status: "planned", requiresAny: ["integration:read"] },
];

// What the browser receives: no permission lists, just what to draw.
export type NavItem = { key: NavIcon; label: string; href: string; section: NavSection };

export function buildNavigation(permissions: ReadonlySet<string>, items: readonly NavItemDefinition[] = NAV_ITEMS): NavItem[] {
  return items
    .filter((item) => item.status === "available")
    .filter((item) => item.requiresAny === "everyone" || item.requiresAny.some((p) => permissions.has(p)))
    .map(({ key, label, href, section }) => ({ key, label, href, section }));
}

// "/dashboard" is active on "/dashboard" and "/dashboard/anything", never on "/dashboards".
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
