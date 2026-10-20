"use client";

// "Forgot password?" in two steps: 1) Organization ID and e-mail, a code is
// e-mailed; 2) the code and a new password. The answer to step 1 is the same
// whether or not the account exists (backend/app/password_reset.py).

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { sessionRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { rememberedOrganization } from "@/lib/client/remember.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { PASSWORD_HINT, passwordProblem } from "@/lib/shared/password.ts";

const noSubscription = () => () => {};

type Step = "ask" | "code" | "done";

export function ForgotPasswordForm() {
  const saved = useSyncExternalStore(noSubscription, rememberedOrganization, () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const organization = typed ?? saved;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [step, setStep] = useState<Step>("ask");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  const account = () => ({ organization_slug: organization.trim().toLowerCase(), email: email.trim() });

  async function send<T>(path: string, body: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await sessionRequest<T>(path, body);
    } catch (caught) {
      setError(caught);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const answer = await send<{ message: string }>("password-reset/request", account());
    if (answer) {
      setMessage(answer.message);
      setStep("code");
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = passwordProblem(password) ?? (password !== repeat ? "The two new passwords are different." : null);
    setLocalProblem(problem);
    if (problem) return;
    const answer = await send<{ message: string }>("password-reset/confirm",
      { ...account(), code: code.trim(), new_password: password });
    if (answer) {
      setMessage(answer.message);
      setStep("done");
    }
  }

  const fields = fieldErrors(error);
  const generalError = error !== null && Object.keys(fields).length === 0
    ? <p role="alert" className="field-error">{describeError(error)}</p> : null;

  if (step === "done") {
    return (
      <div className="card mx-auto my-10 max-w-[380px]">
        <h2>Password changed</h2>
        <p role="status">{message}</p>
        <p><Link href="/login" className="btn w-full text-center no-underline">Go to log in</Link></p>
      </div>
    );
  }

  if (step === "code") {
    return (
      <form className="card mx-auto my-10 max-w-[380px]" onSubmit={confirm} noValidate>
        <h2>Enter the code</h2>
        <p role="status" className="sm">{message}</p>

        <label htmlFor="code">Code from the e-mail</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
               value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
               aria-invalid={Boolean(fields.code)} />
        {fields.code && <p className="field-error">{fields.code}</p>}

        <label htmlFor="new-password">New password</label>
        <input id="new-password" name="new-password" type="password" autoComplete="new-password" required
               value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="new-password-hint"
               aria-invalid={Boolean(fields.new_password || localProblem)} />
        <p id="new-password-hint" className="sm mt-1">{PASSWORD_HINT}</p>
        {fields.new_password && <p className="field-error">{fields.new_password}</p>}

        <label htmlFor="repeat-password">New password again</label>
        <input id="repeat-password" name="repeat-password" type="password" autoComplete="new-password" required
               value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {localProblem && <p role="alert" className="field-error">{localProblem}</p>}

        {generalError}
        <p>
          <button type="submit" className="btn w-full" disabled={busy || code.length !== 6 || !password || !repeat}>
            {busy ? "Saving…" : "Set new password"}
          </button>
        </p>
        <p className="sm">
          No e-mail after a few minutes?{" "}
          <button type="button" className="link-button" onClick={() => { setStep("ask"); setError(null); }}>
            Ask for a new code
          </button>
        </p>
      </form>
    );
  }

  return (
    <form className="card mx-auto my-10 max-w-[380px]" onSubmit={ask} noValidate>
      <h2>Forgot password</h2>
      <p className="sm">We will e-mail you a code to set a new password.</p>

      <label htmlFor="organization">Organization ID</label>
      <input id="organization" name="organization" required autoComplete="organization" value={organization}
             onChange={(e) => setTyped(e.target.value)} aria-invalid={Boolean(fields.organization_slug)} />
      {fields.organization_slug && <p className="field-error">{fields.organization_slug}</p>}

      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="username"
             value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(fields.email)} />
      {fields.email && <p className="field-error">{fields.email}</p>}

      {generalError}
      <p>
        <button type="submit" className="btn w-full" disabled={busy || !organization || !email}>
          {busy ? "Sending…" : "Send code"}
        </button>
      </p>
      <p className="sm"><Link href="/login">Back to log in</Link></p>
    </form>
  );
}
