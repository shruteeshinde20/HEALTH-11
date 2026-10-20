"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { sessionRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { rememberOrganization, rememberedOrganization } from "@/lib/client/remember.ts";
import { describeError } from "@/lib/shared/errors.ts";

// The saved Organization ID never changes while the page is open.
const noSubscription = () => () => {};

export function LoginForm({ next }: { next: string }) {
  // Browser storage is read on the client only (empty on the server).
  const saved = useSyncExternalStore(noSubscription, rememberedOrganization, () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const organization = typed ?? saved;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const slug = organization.trim().toLowerCase();
    try {
      await sessionRequest("login", { organization_slug: slug, email: email.trim(), password });
      rememberOrganization(slug);
      window.location.assign(next);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <form className="card mx-auto my-10 max-w-[380px]" onSubmit={submit} noValidate>
      <h2>Log in to HEALTH-11</h2>

      <label htmlFor="organization">Organization ID</label>
      <input id="organization" name="organization" required autoComplete="organization" value={organization}
             onChange={(e) => setTyped(e.target.value)} aria-describedby="organization-hint"
             aria-invalid={Boolean(fields.organization_slug)} />
      <p id="organization-hint" className="sm mt-1">Shown when your organization was created. Ask your administrator if you do not know it.</p>
      {fields.organization_slug && <p className="field-error">{fields.organization_slug}</p>}

      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="username" placeholder="name@hospital.org"
             value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(fields.email)} />
      {fields.email && <p className="field-error">{fields.email}</p>}

      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" required autoComplete="current-password"
             value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(fields.password)} />
      {fields.password && <p className="field-error">{fields.password}</p>}
      <p className="sm mt-1"><Link href="/forgot-password">Forgot password?</Link></p>

      {error !== null && Object.keys(fields).length === 0 && (
        <p role="alert" className="field-error">{describeError(error)}</p>
      )}
      <p>
        <button type="submit" className="btn w-full" disabled={busy || !organization || !email || !password}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </p>
      <p className="sm">
        New here? <Link href="/register">Create an account</Link>
      </p>
    </form>
  );
}
