"use client";

// Admin (Administrators only): the organization's users and its audit log.
// The API enforces the rules (an organization keeps at least one active
// Administrator, nobody deactivates themselves); this page explains them.

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { Buttons, DeleteConfirm, Field, FormError } from "@/components/facility-forms.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import type { AuditEntry, ManagedUser, Page, Role } from "@/lib/shared/api-types.ts";
import { formatDateTime } from "@/lib/shared/format.ts";
import { PASSWORD_HINT, passwordProblem } from "@/lib/shared/password.ts";

const ROLES: { value: Role; help: string }[] = [
  { value: "Administrator", help: "everything, including users and the audit log" },
  { value: "Emergency Commander", help: "plans and runs simulations; no user management" },
  { value: "Staff User", help: "views the dashboard, live simulation, people and reports" },
];
const AUDIT_PAGE = 50;

function Admin() {
  const user = useUser();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("tab") === "audit" ? "audit" : "users";

  if (user.role !== "Administrator") {
    return (
      <>
        <PageHeader title="Admin" subtitle="Users and audit log." />
        <Card><EmptyState>Only Administrators can manage users and read the audit log.</EmptyState></Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Admin" subtitle="Users and audit log of your organization." />
      <div className="mb-[14px] flex flex-wrap gap-2" role="group" aria-label="Show">
        {(["users", "audit"] as const).map((key) => (
          <button key={key} type="button" className={key === tab ? "btn" : "btn l"} aria-pressed={key === tab}
                  onClick={() => router.replace(`/admin?tab=${key}`, { scroll: false })}>
            {key === "users" ? "Users" : "Audit log"}
          </button>
        ))}
      </div>
      {tab === "users" ? <Users meId={user.id} /> : <AuditLog />}
    </>
  );
}

// --- Users -------------------------------------------------------------------------------

type Open = { kind: "add" } | { kind: "edit"; item: ManagedUser } | { kind: "delete"; item: ManagedUser } | null;

function Users({ meId }: { meId: number }) {
  const users = useAll<ManagedUser>("/users");
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const saved = () => { close(); users.reload(); };

  if (users.error !== null) return <ErrorState error={users.error} onRetry={users.reload} />;
  if (!users.data) return <LoadingState />;
  const sorted = [...users.data].sort((a, b) => a.full_name.localeCompare(b.full_name));

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0">Users ({users.data.length})</h2>
        <button type="button" className="btn" onClick={() => setOpen({ kind: "add" })}>Add user</button>
      </div>
      <DataTable caption="Users" columns={["Name", "Email", "Role", "Status", "Added", ""]}
        rows={sorted.map((u) => ({
          key: u.id,
          cells: [
            <span key="n">{u.full_name}{u.id === meId && <> <Tag tone="p">You</Tag></>}</span>,
            u.email,
            u.role,
            u.is_active ? <Tag key="s" tone="ok">Active</Tag> : <Tag key="s" tone="w">Deactivated</Tag>,
            formatDateTime(u.created_at),
            <span key="a" className="flex flex-wrap gap-2">
              <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit", item: u })}>Edit</button>
              {u.id !== meId && <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete", item: u })}>Delete</button>}
            </span>,
          ],
        }))} />
      <p className="sm">
        Deactivating a user, or setting a new password for them, signs them out everywhere. Your organization always keeps
        at least one active Administrator.
      </p>
      <Dialog open={open?.kind === "add"} title="Add user" onClose={close}>
        {open?.kind === "add" && <UserForm onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "edit"} title="Edit user" onClose={close}>
        {open?.kind === "edit" && <UserForm user={open.item} isMe={open.item.id === meId} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "delete"} title="Delete user" onClose={close}>
        {open?.kind === "delete" && (
          <DeleteConfirm what={`the user “${open.item.full_name}” (${open.item.email})`} path={`/users/${open.item.id}`}
                         onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
    </Card>
  );
}

function UserForm({ user, isMe = false, onSaved, onCancel }: {
  user?: ManagedUser; isMe?: boolean; onSaved: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(user?.full_name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "Staff User");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  // A new user needs a password; an existing one only when it is being reset.
  const passwordIssue = password === "" ? (user ? null : "Enter a first password.") : passwordProblem(password);
  const complete = name.trim().length >= 2 && (user !== undefined || email.trim().length >= 3) && passwordIssue === null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    const done = await run(async () => {
      if (user) {
        await apiRequest(`/users/${user.id}`, { method: "PATCH", body: {
          full_name: name.trim(), role, ...(isMe ? {} : { is_active: active }), ...(password ? { password } : {}),
        } });
      } else {
        await apiRequest("/users", { method: "POST", body: { full_name: name.trim(), email: email.trim(), role, password } });
      }
      return true;
    });
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="user-name" label="Full name" error={fields.full_name}>
        <input id="user-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {user ? (
        <p className="sm mb-0 mt-3">Email: {user.email} (it is the user&apos;s sign-in name and cannot be changed)</p>
      ) : (
        <Field id="user-email" label="Email" error={fields.email}>
          <input id="user-email" type="email" required maxLength={320} autoComplete="off" value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}
      <Field id="user-role" label="Role" error={fields.role}>
        <select id="user-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.value}: {r.help}</option>)}
        </select>
      </Field>
      {user && (
        <label className="flex items-center gap-2 text-tx">
          <input type="checkbox" className="w-auto" checked={active} disabled={isMe} onChange={(e) => setActive(e.target.checked)} />
          Active {isMe && "(you cannot deactivate your own account)"}
        </label>
      )}
      <Field id="user-password" label={user ? "New password (optional)" : "First password"}
             hint={`${PASSWORD_HINT} Give it to the person privately; they can change it in Settings.`}
             error={fields.password ?? (password !== "" ? passwordIssue ?? undefined : undefined)}>
        <input id="user-password" type="password" autoComplete="new-password" maxLength={72} value={password}
               onChange={(e) => setPassword(e.target.value)} aria-describedby="user-password-hint" />
      </Field>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!complete} label={user ? "Save" : "Add user"} onCancel={onCancel} />
    </form>
  );
}

// --- Audit log ---------------------------------------------------------------------------

function AuditLog() {
  const users = useAll<ManagedUser>("/users");
  const [page, setPage] = useState(0);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actor, setActor] = useState<number | null>(null);
  const log = useApi<Page<AuditEntry>>("/audit_log", {
    limit: AUDIT_PAGE, offset: page * AUDIT_PAGE, action: action.trim() || undefined,
    entity_type: entityType.trim() || undefined, actor_user_id: actor ?? undefined,
  });
  const who = (id: number | null) =>
    id === null ? "System" : users.data?.find((u) => u.id === id)?.full_name ?? `User ${id}`;
  const total = log.data?.total ?? 0;
  const last = Math.min(total, (page + 1) * AUDIT_PAGE);

  return (
    <Card>
      <h2 className="mt-0">Audit log</h2>
      <p className="sm mt-0">Every change and sign-in in your organization, newest first. Passwords and patient details are never recorded.</p>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[180px] flex-1">
          <label htmlFor="audit-action">Action (exact)</label>
          <input id="audit-action" placeholder="for example auth.login" value={action}
                 onChange={(e) => { setAction(e.target.value); setPage(0); }} />
        </div>
        <div className="min-w-[180px] flex-1">
          <label htmlFor="audit-type">Item type (exact)</label>
          <input id="audit-type" placeholder="for example scenario" value={entityType}
                 onChange={(e) => { setEntityType(e.target.value); setPage(0); }} />
        </div>
        <div className="min-w-[180px] flex-1">
          <label htmlFor="audit-actor">Who</label>
          <select id="audit-actor" value={actor ?? ""} onChange={(e) => { setActor(e.target.value ? Number(e.target.value) : null); setPage(0); }}>
            <option value="">Everyone</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
      </div>
      {log.error !== null && <ErrorState error={log.error} onRetry={log.reload} />}
      {log.error === null && log.loading && <LoadingState />}
      {log.data && !log.loading && (log.data.items.length === 0 ? <EmptyState>No entries match.</EmptyState> : (
        <>
          <DataTable caption="Audit log" columns={["When", "Who", "Action", "Item", "Details", "IP address"]}
            rows={log.data.items.map((entry) => ({
              key: entry.id,
              cells: [
                formatDateTime(entry.created_at),
                who(entry.actor_user_id),
                <code key="a">{entry.action}</code>,
                `${entry.entity_type}${entry.entity_id !== null ? ` ${entry.entity_id}` : ""}`,
                <span key="d" className="sm">{detailsText(entry.details)}</span>,
                entry.ip_address ?? "–",
              ],
            }))} />
          <p className="flex flex-wrap items-center gap-2">
            <span className="sm">Showing {page * AUDIT_PAGE + 1}–{last} of {total}</span>
            <button type="button" className="btn l" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <button type="button" className="btn l" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>Older</button>
          </p>
        </>
      ))}
    </Card>
  );
}

/** {"fields": ["name"], "role": "Staff User"} -> "fields: name · role: Staff User" (shown as text, never as markup). */
function detailsText(details: Record<string, unknown> | null): string {
  if (!details) return "–";
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}

export default function AdminPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Admin />
    </Suspense>
  );
}
