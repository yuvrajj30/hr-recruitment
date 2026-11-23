import { type ReactNode, Suspense } from "react";
import { RecruitmentTabs, type RecruitmentTab } from "@/components/recruitment/recruitment-tabs";
import { readScope } from "@/lib/auth/permissions";
import { getCurrentAuth } from "@/lib/auth/server-session";

// Every recruitment page gets the section tabs (Jobs, Applications, Pipeline, Candidates).
// A tab is shown only to people whose role can open it. Hiding a tab is tidiness only:
// each page and every action checks permissions again on the server.
export default function RecruitmentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-[38px] border-b border-border" />}>
        <Tabs />
      </Suspense>
      {children}
    </div>
  );
}

async function Tabs() {
  const auth = await getCurrentAuth();
  if (!auth) return null; // the page itself sends the person to sign in
  const tabs: RecruitmentTab[] = [];
  if (auth.permissions.has("job:read")) tabs.push({ href: "/recruitment", label: "Jobs" });
  if (readScope(auth.permissions, "application") !== "none") {
    tabs.push({ href: "/recruitment/applications", label: "Applications" });
    tabs.push({ href: "/recruitment/pipeline", label: "Pipeline" });
  }
  if (readScope(auth.permissions, "candidate") !== "none") {
    tabs.push({ href: "/recruitment/candidates", label: "Candidates" });
    tabs.push({ href: "/recruitment/privacy", label: "Privacy" });
  }
  return <RecruitmentTabs tabs={tabs} />;
}
