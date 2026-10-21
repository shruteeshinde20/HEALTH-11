"use client";

// Settings / Profile: your own name and password, and the numbers the models
// use (PROJECT.md: parameters with unit and source; "assumed, to be
// validated" when there is no citation). Everything comes from the API.

import { useState, type FormEvent } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { Buttons, DeleteConfirm, Field, FormError } from "@/components/facility-forms.tsx";
import { Card, DataTable, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest, sessionRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useSession, useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import type { ParameterSpec, StoredParameter, User } from "@/lib/shared/api-types.ts";
import { PASSWORD_HINT, passwordProblem } from "@/lib/shared/password.ts";

const ASSUMED = "assumed, to be validated";

export default function SettingsPage() {
  const user = useUser();
  return (
    <>
      <PageHeader title="Settings / Profile" subtitle="Your details and simulation speeds." />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-[14px]">
        <Profile user={user} />
        <PasswordChange />
      </div>
      <Parameters canEdit={user.role !== "Staff User"} />
    </>
  );
}

// --- Profile -----------------------------------------------------------------------------

function Profile({ user }: { user: User }) {
  const { updateUser } = useSession();
  const [name, setName] = useState(user.full_name);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const changed = name.trim() !== user.full_name;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length < 2 || !changed) return;
    const updated = await run(() => apiRequest<User>("/auth/me", { method: "PATCH", body: { full_name: name.trim() } }));
    if (updated) {
      updateUser(updated);
      setSaved(true);
    }
  }

  return (
    <Card>
      <h2 className="mt-0">Your profile</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Email</dt><dd className="m-0">{user.email}</dd>
        <dt>Role</dt><dd className="m-0">{user.role}</dd>
      </dl>
      <p className="sm">Your email and role are managed by an Administrator.</p>
      <form onSubmit={submit} noValidate>
        <Field id="profile-name" label="Full name" error={fields.full_name}>
          <input id="profile-name" required maxLength={200} autoComplete="name" value={name}
                 onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        </Field>
        <FormError error={error} />
        {saved && <p role="status" className="sm"><Tag tone="ok">Saved</Tag> Your name was updated.</p>}
        <Buttons busy={busy} disabled={name.trim().length < 2 || !changed} label="Save name" />
      </form>
    </Card>
  );
}

// --- Password ----------------------------------------------------------------------------

function PasswordChange() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const problem = next ? passwordProblem(next) : null;
  const mismatch = repeat !== "" && repeat !== next;
  const complete = current !== "" && next !== "" && problem === null && repeat === next;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    const ok = await run(async () => {
      await sessionRequest("password", { current_password: current, new_password: next });
      return true;
    });
    if (ok) {
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    }
  }

  return (
    <Card>
      <h2 className="mt-0">Change password</h2>
      <form onSubmit={submit} noValidate>
        <Field id="password-current" label="Current password" error={fields.current_password}>
          <input id="password-current" type="password" autoComplete="current-password" maxLength={72} value={current}
                 onChange={(e) => { setCurrent(e.target.value); setDone(false); }} />
        </Field>
        <Field id="password-new" label="New password" hint={PASSWORD_HINT} error={fields.new_password ?? problem ?? undefined}>
          <input id="password-new" type="password" autoComplete="new-password" maxLength={72} value={next}
                 aria-describedby="password-new-hint" onChange={(e) => { setNext(e.target.value); setDone(false); }} />
        </Field>
        <Field id="password-repeat" label="Repeat the new password" error={mismatch ? "The passwords do not match." : undefined}>
          <input id="password-repeat" type="password" autoComplete="new-password" maxLength={72} value={repeat}
                 onChange={(e) => { setRepeat(e.target.value); setDone(false); }} />
        </Field>
        <FormError error={error} />
        {done && (
          <p role="status" className="sm">
            <Tag tone="ok">Changed</Tag> Your password was changed. You stay signed in here; other devices were signed out.
          </p>
        )}
        <Buttons busy={busy} disabled={!complete} label="Change password" />
      </form>
    </Card>
  );
}

// --- Model parameters --------------------------------------------------------------------

type Open = { kind: "edit"; spec: ParameterSpec; stored: StoredParameter | null }
  | { kind: "reset"; stored: StoredParameter } | null;

function Parameters({ canEdit }: { canEdit: boolean }) {
  const specs = useApi<ParameterSpec[]>("/parameters/specs");
  const stored = useAll<StoredParameter>("/parameters");
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const saved = () => { close(); stored.reload(); };
  const error = specs.error ?? stored.error;

  const byName = new Map((stored.data ?? []).map((p) => [p.name, p]));
  const known = new Set((specs.data ?? []).map((s) => s.name));
  const others = (stored.data ?? []).filter((p) => !known.has(p.name));

  return (
    <Card className="mt-[14px]">
      <h2 className="mt-0">Model parameters</h2>
      <p className="sm mt-0">
        The numbers the simulation, hazard, bottleneck, priority and prediction models use. Each shows where it comes from;
        a default is used until your organization saves its own value. Changes apply to new runs; saved runs keep the
        numbers they used.
      </p>
      {error !== null && <ErrorState error={error} onRetry={() => { specs.reload(); stored.reload(); }} />}
      {error === null && (!specs.data || !stored.data) && <LoadingState />}
      {specs.data && stored.data && (
        <DataTable caption="Model parameters" columns={["Parameter", "Value", "Allowed", "Source", ""]}
          rows={specs.data.map((spec) => {
            const own = byName.get(spec.name) ?? null;
            return {
              key: spec.name,
              cells: [
                <span key="n"><code>{spec.name}</code><span className="sm block">{spec.meaning}</span></span>,
                <span key="v">
                  {own ? own.value : spec.default} {spec.unit}{" "}
                  {own ? <Tag tone="p">Yours</Tag> : <Tag tone="w">Default</Tag>}
                </span>,
                `${spec.minimum} to ${spec.maximum}`,
                own ? own.source : `default (${ASSUMED})`,
                canEdit ? (
                  <span key="a" className="flex flex-wrap gap-2">
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit", spec, stored: own })}>Edit</button>
                    {own && <button type="button" className="btn l" onClick={() => setOpen({ kind: "reset", stored: own })}>Use default</button>}
                  </span>
                ) : "",
              ],
            };
          })} />
      )}
      {others.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-[14px] font-bold text-ink">Other saved parameters</h3>
          <p className="sm mt-0">Not read by the models; kept for your records.</p>
          <ul className="sm pl-5">
            {others.map((p) => <li key={p.id}><code>{p.name}</code> = {p.value}{p.unit ? ` ${p.unit}` : ""} (source: {p.source})</li>)}
          </ul>
        </>
      )}
      <Dialog open={open?.kind === "edit"} title="Edit parameter" onClose={close}>
        {open?.kind === "edit" && <ParameterForm spec={open.spec} stored={open.stored} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "reset"} title="Use the default" onClose={close}>
        {open?.kind === "reset" && (
          <DeleteConfirm what={`your value for “${open.stored.name}” (the default is used again)`}
                         path={`/parameters/${open.stored.id}`} onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
    </Card>
  );
}

function ParameterForm({ spec, stored, onSaved, onCancel }: {
  spec: ParameterSpec; stored: StoredParameter | null; onSaved: () => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(stored?.value ?? String(spec.default));
  const [source, setSource] = useState(stored?.source ?? ASSUMED);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const number = Number(value);
  const valueOk = value.trim() !== "" && Number.isFinite(number) && number >= spec.minimum && number <= spec.maximum;
  const complete = valueOk && source.trim() !== "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    const done = await run(async () => {
      if (stored) {
        await apiRequest(`/parameters/${stored.id}`, { method: "PATCH", body: { value: value.trim(), source: source.trim() } });
      } else {
        await apiRequest("/parameters", { method: "POST", body: {
          name: spec.name, value: value.trim(), unit: spec.unit, source: source.trim(),
        } });
      }
      return true;
    });
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="mt-0"><code>{spec.name}</code>: {spec.meaning}</p>
      <Field id="parameter-value" label={`Value (${spec.unit})`} hint={`From ${spec.minimum} to ${spec.maximum}. Default ${spec.default}.`}
             error={fields.value ?? (!valueOk && value.trim() !== "" ? `Enter a number from ${spec.minimum} to ${spec.maximum}.` : undefined)}>
        <input id="parameter-value" type="number" step="any" min={spec.minimum} max={spec.maximum} value={value}
               aria-describedby="parameter-value-hint" onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field id="parameter-source" label="Source"
             hint={`A citation, for example a standard or study with its table or page, or “${ASSUMED}” when there is none.`}
             error={fields.source}>
        <input id="parameter-source" required maxLength={300} value={source} aria-describedby="parameter-source-hint"
               onChange={(e) => setSource(e.target.value)} />
      </Field>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!complete} label="Save" onCancel={onCancel} />
    </form>
  );
}
