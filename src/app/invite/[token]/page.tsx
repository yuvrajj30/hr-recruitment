import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { acceptInvitationAction } from "@/app/invite/actions";
import { AcceptInvitationForm } from "@/components/users/accept-invitation-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { lookupInvitation, LINK_NOT_VALID } from "@/lib/users/accept";

// The page an invitation link opens. No sign-in needed: holding the link is what proves the email.
// An invalid, expired, used or revoked link gets one neutral message.

export const metadata: Metadata = { title: "Accept invitation · HRMS", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function InvitePage(props: PageProps<"/invite/[token]">) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <Suspense fallback={<Skeleton className="h-96 rounded-[10px]" />}>
          <Invitation params={props.params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Invitation({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await connection();
  const view = await lookupInvitation(getAuthRuntime().db, token);
  if (!view) {
    return (
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Invitation not valid</h1>
        <p className="mt-2 text-sm text-fg-muted">{LINK_NOT_VALID}</p>
        <div className="mt-6">
          <Button variant="secondary" asChild>
            <Link href="/login">Go to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="text-center">
        <span aria-hidden className="mx-auto flex size-10 items-center justify-center rounded-[10px] bg-accent text-base font-bold text-on-accent">
          H
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Join {view.organizationName}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          You have been invited as {/^[AEIOU]/.test(ROLE_LABELS[view.role]) ? "an" : "a"} {ROLE_LABELS[view.role]}.
          {view.accountExists ? " Confirm with your existing password." : " Set up your account to continue."}
        </p>
      </div>
      <AcceptInvitationForm action={acceptInvitationAction.bind(null, token)} email={view.email} name={view.name} accountExists={view.accountExists} />
    </div>
  );
}
