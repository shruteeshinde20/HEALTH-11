"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { sessionRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { rememberOrganization } from "@/lib/client/remember.ts";
import { HOME_PATH } from "@/lib/shared/navigation.ts";
import { describeError } from "@/lib/shared/errors.ts";

// Limits from the backend (RegisterRequest in backend/app/auth.py).
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 72;

type Created = { organization: { name: string; slug: string } };

export function RegisterForm() {
  const [form, setForm] = useState({ organization_name: "", full_name: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const set = (field: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [field]: value }));

  const problems: Record<string, string> = {};
  if (form.password && form.password.length < PASSWORD_MIN) problems.password = `Use at least ${PASSWORD_MIN} characters.`;
  if (form.password.length > PASSWORD_MAX) problems.password = `Use at most ${PASSWORD_MAX} characters.`;
  if (form.confirm && form.confirm !== form.password) problems.confirm = "The passwords do not match.";
  const complete = form.organization_name.trim().length >= 2 && form.full_name.trim().length >= 2
    && form.email.trim().length >= 3 && form.password.length >= PASSWORD_MIN && form.confirm === form.password;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || Object.keys(problems).length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sessionRequest<Created>("register", {
        organization_name: form.organization_name.trim(), full_name: form.full_name.trim(),
        email: form.email.trim(), password: form.password,
      });
      rememberOrganization(result.organization.slug);
      setCreated(result);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <section className="card mx-auto my-10 max-w-[420px]" aria-labelledby="created-title">
        <h2 id="created-title">Your organization is ready</h2>
        <p>
          <strong>{created.organization.name}</strong> was created and you are its Administrator.
        </p>
        <p>Your Organization ID is needed to log in. Keep it and share it with your team:</p>
        <p className="big break-all" aria-label="Organization ID">{created.organization.slug}</p>
        <p>
          <a className="btn" href={HOME_PATH}>Continue to the dashboard</a>
        </p>
      </section>
    );
  }

  const fields = { ...fieldErrors(error), ...problems };
  const input = (id: keyof typeof form, label: string, type = "text", autoComplete?: string, hint?: string) => (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type={type} required autoComplete={autoComplete} value={form[id]}
             onChange={(e) => set(id)(e.target.value)} aria-invalid={Boolean(fields[id])}
             aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <p id={`${id}-hint`} className="sm mt-1">{hint}</p>}
      {fields[id] && <p className="field-error">{fields[id]}</p>}
    </>
  );

  return (
    <form className="card mx-auto my-10 max-w-[420px]" onSubmit={submit} noValidate>
      <h2>Create an account</h2>
      <p className="sm">Register your hospital or organization. You become its first Administrator.</p>
      {input("organization_name", "Organization name", "text", "organization")}
      {input("full_name", "Your name", "text", "name")}
      {input("email", "Email", "email", "email")}
      {input("password", "Password", "password", "new-password", `${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`)}
      {input("confirm", "Repeat password", "password", "new-password")}
      {error !== null && Object.keys(fieldErrors(error)).length === 0 && (
        <p role="alert" className="field-error">{describeError(error)}</p>
      )}
      <p>
        <button type="submit" className="btn w-full" disabled={busy || !complete || Object.keys(problems).length > 0}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </p>
      <p className="sm">
        Already registered? <Link href="/login">Log in</Link>
      </p>
    </form>
  );
}
