"use client";

import { Check, Copy } from "lucide-react";
import { startTransition, useActionState, useId, useState } from "react";
import { invitationAction, inviteAction, inviteSettingAction, memberAction } from "@/app/(app)/users/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ROLE_LABELS, type RoleKey } from "@/lib/auth/roles";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// Shows a freshly created invitation link once, with a copy button. The link is not stored anywhere
// readable, so it cannot be shown again later (sending a new one replaces it).
function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-success/40 bg-success-soft p-3" role="status">
      <p className="text-[13px] font-medium text-fg">Invitation created. Copy this link and send it to the person yourself (for example by WhatsApp or email).</p>
      <div className="flex gap-2">
        <Input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">It works once and expires in 7 days. For safety it will not be shown again.</p>
    </div>
  );
}

export function InviteForm({ roles }: { roles: RoleKey[] }) {
  const [state, action, pending] = useActionState(inviteAction, EMPTY_FORM_STATE);
  const values = state.values ?? {};
  const e = state.fieldErrors;
  const id = useId();
  return (
    <div className="space-y-4">
      {state.reference && <InviteLink link={state.reference} />}
      <form key={state.done ?? 0} action={action} noValidate className="grid gap-3 sm:grid-cols-[1fr_1fr_11rem_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} name="name" defaultValue={values.name} maxLength={120} aria-invalid={e.name ? true : undefined} />
          {e.name && <p className="text-xs font-medium text-danger">{e.name}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input id={`${id}-email`} name="email" type="email" defaultValue={values.email} maxLength={254} autoCapitalize="none" spellCheck={false} aria-invalid={e.email ? true : undefined} />
          {e.email && <p className="text-xs font-medium text-danger">{e.email}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-role`}>Role</Label>
          <Select id={`${id}-role`} name="role" defaultValue={values.role ?? roles[roles.length - 1]}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" loading={pending}>
          Create invitation
        </Button>
      </form>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
    </div>
  );
}

export function InvitationButtons({ invitationId, canResend }: { invitationId: string; canResend: boolean }) {
  const [state, action, pending] = useActionState(invitationAction, EMPTY_FORM_STATE);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap justify-end gap-2">
        <input type="hidden" name="invitationId" value={invitationId} />
        {canResend && (
          <Button type="submit" name="op" value="resend" size="sm" variant="secondary" loading={pending}>
            New link
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)} disabled={pending}>
          Revoke
        </Button>
      </form>
      {state.reference && <InviteLink link={state.reference} />}
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Revoke this invitation?"
        description="The link stops working immediately. You can invite the person again later."
        confirmLabel="Revoke"
        busy={pending}
        onConfirm={() => {
          const data = new FormData();
          data.set("invitationId", invitationId);
          data.set("op", "revoke");
          setConfirm(false);
          startTransition(() => action(data));
        }}
      />
    </div>
  );
}

export function MemberControls({ memberId, name, role, roleChoices, canActivate, active }: {
  memberId: string;
  name: string;
  role: RoleKey | null;
  roleChoices: RoleKey[];
  canActivate: boolean;
  active: boolean;
}) {
  const [state, action, pending] = useActionState(memberAction, EMPTY_FORM_STATE);
  const [nextRole, setNextRole] = useState<RoleKey | "">(role ?? "");
  const [confirm, setConfirm] = useState<"role" | "status" | null>(null);
  const id = useId();
  const send = (op: string, extra: Record<string, string> = {}) => {
    const data = new FormData();
    data.set("memberId", memberId);
    data.set("op", op);
    for (const [k, v] of Object.entries(extra)) data.set(k, v);
    setConfirm(null);
    startTransition(() => action(data));
  };
  const canChangeRole = roleChoices.length > 1;
  if (!canChangeRole && !canActivate) return <span className="text-xs text-fg-subtle">—</span>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canChangeRole && (
          <>
            <Label htmlFor={id} className="sr-only">
              Role for {name}
            </Label>
            <Select id={id} value={nextRole} onChange={(e) => setNextRole(e.target.value as RoleKey)} className="h-8 w-40 text-[13px]" disabled={pending}>
              {roleChoices.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="secondary" disabled={pending || nextRole === role || !nextRole} onClick={() => setConfirm("role")}>
              Change role
            </Button>
          </>
        )}
        {canActivate && (
          <Button size="sm" variant={active ? "ghost" : "secondary"} disabled={pending} onClick={() => setConfirm("status")}>
            {active ? "Deactivate" : "Reactivate"}
          </Button>
        )}
      </div>
      {state.message && <Alert tone="danger">{state.message}</Alert>}
      <ConfirmDialog
        open={confirm === "role"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Change ${name}'s role?`}
        description={`${name} becomes ${nextRole ? ROLE_LABELS[nextRole as RoleKey] : ""}. They are signed out and get the new access when they sign in again.`}
        confirmLabel="Change role"
        tone="primary"
        busy={pending}
        onConfirm={() => send("role", { role: nextRole })}
      />
      <ConfirmDialog
        open={confirm === "status"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={active ? `Deactivate ${name}?` : `Reactivate ${name}?`}
        description={active ? `${name} is signed out immediately and cannot sign in to this organisation until reactivated. Nothing is deleted.` : `${name} can sign in again with their existing password.`}
        confirmLabel={active ? "Deactivate" : "Reactivate"}
        tone={active ? "danger" : "primary"}
        busy={pending}
        onConfirm={() => send(active ? "deactivate" : "reactivate")}
      />
    </div>
  );
}

export function InviteSettingForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(inviteSettingAction, EMPTY_FORM_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 text-[13px]">
        <p className="font-medium text-fg">HR Managers may invite Employees</p>
        <p className="text-fg-muted">{enabled ? "On: HR Managers can create Employee invitations." : "Off: only Super Admins can invite people."}</p>
      </div>
      <input type="hidden" name="hrCanInviteEmployees" value={enabled ? "off" : "on"} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        {enabled ? "Turn off" : "Turn on"}
      </Button>
      {state.message && <Alert tone="danger" className="basis-full">{state.message}</Alert>}
    </form>
  );
}
