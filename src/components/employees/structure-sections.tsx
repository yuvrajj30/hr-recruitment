"use client";

import { useActionState, useId, useState } from "react";
import { structureAction } from "@/app/(app)/employees/actions";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import type { StructureItem, StructureKind } from "@/lib/employees/employees";
import { EMPTY_FORM_STATE } from "@/lib/recruitment/form-state";

// Outlets, departments and designations: list, add, rename, deactivate / activate. Without `canManage` the
// lists are read-only. The server checks permission again on every change.

const COPY: Record<StructureKind, { title: string; description: string; noun: string }> = {
  outlet: { title: "Outlets", description: "The places your team works at.", noun: "outlet" },
  department: { title: "Departments", description: "For example Kitchen or Front of house.", noun: "department" },
  designation: { title: "Designations", description: "Job titles, for example Barista or Shift supervisor.", noun: "designation" },
};

export function StructureSection({ kind, items, canManage }: { kind: StructureKind; items: StructureItem[]; canManage: boolean }) {
  const copy = COPY[kind];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <p className="text-[13px] text-fg-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((i) => (
              <ItemRow key={i.id} kind={kind} item={i} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <AddForm kind={kind} />}
      </CardBody>
    </Card>
  );
}

function ItemRow({ kind, item, canManage }: { kind: StructureKind; item: StructureItem; canManage: boolean }) {
  const [state, formAction, pending] = useActionState(structureAction, EMPTY_FORM_STATE);
  const [editing, setEditing] = useState(false);
  const [seenDone, setSeenDone] = useState(0);
  const id = useId();
  // Close the rename form once a change has been saved.
  if ((state.done ?? 0) !== seenDone) {
    setSeenDone(state.done ?? 0);
    setEditing(false);
  }

  return (
    <li className="space-y-2 px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className={item.isActive ? "font-medium text-fg" : "font-medium text-fg-muted"}>{item.name}</span>
          {!item.isActive && (
            <Badge className="ml-2" tone="neutral">
              Inactive
            </Badge>
          )}
          {kind === "outlet" && item.address && <div className="mt-0.5 text-xs text-fg-muted">{item.address}</div>}
          <div className="mt-0.5 text-xs text-fg-muted">
            {item.employees} active {item.employees === 1 ? "employee" : "employees"}
          </div>
        </div>
        {canManage && !editing && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
            <form action={formAction}>
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="op" value={item.isActive ? "deactivate" : "activate"} />
              <Button type="submit" size="sm" variant="secondary" loading={pending}>
                {item.isActive ? "Deactivate" : "Activate"}
              </Button>
            </form>
          </div>
        )}
      </div>
      {!editing && state.message && <Alert tone="danger">{state.message}</Alert>}
      {editing && (
        <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="op" value="rename" />
          <Fields kind={kind} idPrefix={id} state={state} name={item.name} address={item.address ?? ""} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={pending}>
              Save
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {state.message && !editing && <Alert tone="danger">{state.message}</Alert>}
    </li>
  );
}

function AddForm({ kind }: { kind: StructureKind }) {
  const [state, formAction, pending] = useActionState(structureAction, EMPTY_FORM_STATE);
  const id = useId();
  return (
    <form key={state.done ?? 0} action={formAction} className="space-y-2 rounded-md border border-dashed border-border p-3">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="op" value="create" />
      <Fields kind={kind} idPrefix={id} state={state} name={state.values?.name ?? ""} address={state.values?.address ?? ""} label={`New ${COPY[kind].noun}`} />
      <Button type="submit" size="sm" loading={pending}>
        Add {COPY[kind].noun}
      </Button>
    </form>
  );
}

function Fields({
  kind,
  idPrefix,
  state,
  name,
  address,
  label = "Name",
}: {
  kind: StructureKind;
  idPrefix: string;
  state: { message: string | null; fieldErrors: Record<string, string>; values?: Record<string, string | undefined> };
  name: string;
  address: string;
  label?: string;
}) {
  const nameError = state.fieldErrors.name;
  const addressError = state.fieldErrors.address;
  return (
    <>
      {state.message && !nameError && !addressError && <Alert tone="danger">{state.message}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{label}</Label>
        <Input id={`${idPrefix}-name`} name="name" defaultValue={state.values?.name ?? name} maxLength={120} required aria-invalid={nameError ? true : undefined} />
        {nameError && <p className="text-xs font-medium text-danger">{nameError}</p>}
      </div>
      {kind === "outlet" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-address`}>
            Address <span className="font-normal text-fg-subtle">(optional)</span>
          </Label>
          <Input id={`${idPrefix}-address`} name="address" defaultValue={state.values?.address ?? address} maxLength={500} aria-invalid={addressError ? true : undefined} />
          {addressError && <p className="text-xs font-medium text-danger">{addressError}</p>}
        </div>
      )}
    </>
  );
}
