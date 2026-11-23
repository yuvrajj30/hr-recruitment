"use client";

import { useActionState } from "react";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/app/(app)/tasks/actions";
import { FormMessage } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const [state, formAction, pending] = useActionState(markNotificationReadAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        Mark as read
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function MarkAllReadButton() {
  const [state, formAction, pending] = useActionState(markAllNotificationsReadAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Mark all as read
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
