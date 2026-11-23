"use client";

import { useActionState } from "react";
import { clockAction } from "@/app/(app)/attendance/actions";
import { FormMessage } from "@/components/attendance/form-bits";
import { Button } from "@/components/ui/button";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// The big clock-in / clock-out / break buttons. The person and the time are decided on the server, not here.

export function ClockButtons({ mode }: { mode: "out" | "in" | "break" }) {
  const [state, formAction, pending] = useActionState(clockAction, EMPTY_FORM_STATE);
  const big = "h-14 w-full text-base sm:w-auto sm:min-w-40";
  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        {mode === "out" && (
          <Button type="submit" name="op" value="in" loading={pending} className={big}>
            Clock in
          </Button>
        )}
        {mode === "in" && (
          <>
            <Button type="submit" name="op" value="break_start" variant="secondary" loading={pending} className={big}>
              Start break
            </Button>
            <Button type="submit" name="op" value="out" variant="danger" loading={pending} className={big}>
              Clock out
            </Button>
          </>
        )}
        {mode === "break" && (
          <>
            <Button type="submit" name="op" value="break_end" loading={pending} className={big}>
              End break
            </Button>
            <Button type="submit" name="op" value="out" variant="danger" loading={pending} className={big}>
              Clock out
            </Button>
          </>
        )}
      </div>
      <FormMessage state={state} tone="warning" />
    </form>
  );
}
