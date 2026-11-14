import {
  BarChart3,
  Blocks,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Settings,
  Target,
  UserPlus,
  Users,
  UserCog,
  Briefcase,
} from "lucide-react";
import type { NavIcon } from "@/lib/navigation";

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  employees: Users,
  recruitment: Briefcase,
  interviews: CalendarClock,
  attendance: CalendarCheck,
  leave: CalendarCheck,
  onboarding: UserPlus,
  performance: Target,
  forms: ClipboardList,
  reports: BarChart3,
  announcements: Megaphone,
  settings: Settings,
  users: UserCog,
  integrations: Blocks,
};
