import { MailPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/recruitment/job-bits";
import { InvitationButtons, InviteForm, InviteSettingForm, MemberControls } from "@/components/users/user-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { getOrganizationSettings } from "@/lib/recruitment/jobs";
import { formatDate, formatDateTime } from "@/lib/recruitment/labels";
import { getInviteSettings, listInvitations, listPeople } from "@/lib/users/members";
import { canInvite, canSetStatus, invitableRoles, roleChoices } from "@/lib/users/rules";

export const metadata: Metadata = { title: "Users and roles · HRMS" };

export default function UsersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[32rem]" />}>
      <UsersContent />
    </Suspense>
  );
}

const ROLE_TONES = { SUPER_ADMIN: "accent", HR_MANAGER: "success", EMPLOYEE: "neutral" } as const;
const INVITE_TONES = { pending: "accent", expired: "warning", accepted: "success", revoked: "neutral" } as const;

async function UsersContent() {
  const auth = await getCurrentAuth();
  if (!auth) redirect("/login?next=%2Fusers&reason=expired");
  if (!auth.permissions.has("user:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Users and roles" />
        <NoAccess what="manage users" />
      </div>
    );
  }
  const rt = getAuthRuntime();
  const now = rt.now();
  const [people, invitations, settings, { timezone }] = await Promise.all([
    listPeople(rt.db, auth),
    listInvitations(rt.db, auth, now),
    getInviteSettings(rt.db, auth),
    getOrganizationSettings(rt.db, auth),
  ]);
  const actor = { userId: auth.user.id, permissions: auth.permissions };
  const roles = invitableRoles(auth.permissions, settings.hrCanInviteEmployees);
  const isSuperAdmin = auth.permissions.has("user:manage_super_admin");
  const hrInvitesBlocked = !isSuperAdmin && auth.permissions.has("user:invite_employee") && !settings.hrCanInviteEmployees;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users and roles"
        description={isSuperAdmin ? "Everyone in your organisation, their roles and invitations." : "Everyone in your organisation. You can invite and manage Employee accounts."}
      />

      {isSuperAdmin && (
        <Card>
          <CardBody>
            <InviteSettingForm enabled={settings.hrCanInviteEmployees} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Invite someone</CardTitle>
            <CardDescription>They get a one-time link to set their own password. There is no public sign-up.</CardDescription>
          </div>
          <MailPlus className="size-5 text-fg-subtle" aria-hidden />
        </CardHeader>
        <CardBody>
          {roles.length > 0 ? (
            <InviteForm roles={roles} />
          ) : (
            <p className="text-[13px] text-fg-muted">{hrInvitesBlocked ? "A Super Admin has turned off invitations by HR Managers." : "Your role cannot invite people."}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>People</CardTitle>
            <CardDescription>
              {people.length} {people.length === 1 ? "person" : "people"}. Nobody can change their own role or status, and the organisation owner always stays a Super Admin.
            </CardDescription>
          </div>
        </CardHeader>
        {people.length === 0 ? (
          <EmptyState icon={Users} title="Nobody here yet" description="Invite your first colleague above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Person</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Last sign-in</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {people.map((p) => {
                  const target = { userId: p.userId, role: p.role, isOwner: p.isOwner };
                  return (
                    <tr key={p.memberId}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-fg">
                          {p.name}
                          {p.isSelf && <span className="ml-1.5 text-xs font-normal text-fg-muted">(you)</span>}
                          {p.isOwner && <span className="ml-1.5 text-xs font-normal text-fg-muted">(owner)</span>}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-muted">{p.email}</p>
                      </td>
                      <td className="px-3 py-3">{p.role ? <Badge tone={ROLE_TONES[p.role]}>{ROLE_LABELS[p.role]}</Badge> : <span className="text-fg-muted">No role</span>}</td>
                      <td className="px-3 py-3">
                        {p.accountDisabled ? <Badge tone="danger">Account disabled</Badge> : p.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>}
                      </td>
                      <td className="px-3 py-3 text-fg-muted">{p.lastLoginAt ? formatDateTime(p.lastLoginAt, timezone) : "Never"}</td>
                      <td className="px-5 py-3">
                        <MemberControls
                          memberId={p.memberId}
                          name={p.name}
                          role={p.role}
                          roleChoices={roleChoices(actor, target)}
                          canActivate={canSetStatus(actor, target).ok}
                          active={p.status === "ACTIVE"}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Invitations</CardTitle>
              <CardDescription>Open invitations, and those accepted or revoked in the last 30 days.</CardDescription>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Invited</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Sent</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-fg">{i.name}</p>
                      <p className="mt-0.5 text-xs text-fg-muted">{i.email}</p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={ROLE_TONES[i.role]}>{ROLE_LABELS[i.role]}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={INVITE_TONES[i.state]}>{i.state === "pending" ? `Pending · expires ${formatDate(i.expiresAt, timezone)}` : i.state[0]!.toUpperCase() + i.state.slice(1)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {formatDate(i.createdAt, timezone)}
                      {i.invitedByName && ` by ${i.invitedByName}`}
                    </td>
                    <td className="px-5 py-3">
                      {(i.state === "pending" || i.state === "expired") && canInvite(auth.permissions, i.role, true).ok ? (
                        <InvitationButtons invitationId={i.id} canResend={canInvite(auth.permissions, i.role, settings.hrCanInviteEmployees).ok} />
                      ) : (
                        <span className="block text-right text-xs text-fg-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
