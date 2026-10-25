// Log in and Register (demo accounts only; passwords are checked for the rules but not stored).
import { esc, toast } from "../ui.js";

export function render(root, ctx, path) {
  if (path === "register") return register(root, ctx);
  const users = ctx.store.state.users.filter((u) => u.active);
  root.innerHTML = `<div class="auth">
    <div><a href="#/" class="small">← Back to the start page</a></div>
    <div class="card stack">
      <h1>Log in</h1>
      <p class="small muted">Demo log-in: these are made-up demo accounts and no password is stored. Choose a role to see what that person can do.</p>
      <form id="lf" class="stack" novalidate>
        <label class="f">Email<input type="email" id="em" autocomplete="username" value="${esc(users[0]?.email ?? "")}" required></label>
        <label class="f">Password<input type="password" id="pw" autocomplete="current-password" value="demo-password" required></label>
        <p class="small" id="lerr" role="alert" style="color:var(--bad-ink)"></p>
        <button class="btn primary" type="submit">Log in</button>
      </form>
      <div class="stack">
        <h3>Quick demo log-in</h3>
        ${users.map((u) => `<button class="btn" data-email="${esc(u.email)}">${esc(u.role)} · ${esc(u.name)}</button>`).join("")}
      </div>
      <p class="small">No account yet? <a href="#/register">Create an account</a></p>
    </div>
  </div>`;
  const doLogin = (email) => {
    const r = ctx.store.login(email);
    if (!r.ok) {
      document.getElementById("lerr").textContent = r.message;
      return;
    }
    toast(`Logged in as ${r.user.name} (${r.user.role})`);
    ctx.go(ctx.store.state.onboarded || r.user.role === "Staff User" ? "dashboard" : "onboarding");
  };
  root.querySelector("#lf").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const email = root.querySelector("#em").value;
    const pw = root.querySelector("#pw").value;
    if (!email || !pw) {
      document.getElementById("lerr").textContent = "Enter your email and password.";
      return;
    }
    doLogin(email);
  });
  for (const b of root.querySelectorAll("[data-email]")) b.addEventListener("click", () => doLogin(b.dataset.email));
}

function register(root, ctx) {
  root.innerHTML = `<div class="auth">
    <div><a href="#/" class="small">← Back to the start page</a></div>
    <div class="card stack">
      <h1>Create an account</h1>
      <p class="small muted">In the real app a new hospital registers its own organisation and the first person becomes its Administrator. In this demo your account joins the demo organisation as an Administrator, then the setup wizard opens.</p>
      <form id="rf" class="stack" novalidate>
        <label class="f">Your name<input type="text" id="nm" maxlength="80" required></label>
        <label class="f">Email<input type="email" id="em" maxlength="120" required></label>
        <label class="f">Password<input type="password" id="pw" required><span class="small muted">At least 10 characters, with a letter and a number.</span></label>
        <p class="small" id="rerr" role="alert" style="color:var(--bad-ink)"></p>
        <button class="btn primary" type="submit">Create account</button>
      </form>
      <p class="small">Already have an account? <a href="#/login">Log in</a></p>
    </div>
  </div>`;
  root.querySelector("#rf").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = root.querySelector("#nm").value.trim();
    const email = root.querySelector("#em").value.trim();
    const pw = root.querySelector("#pw").value;
    const err = (m) => (document.getElementById("rerr").textContent = m);
    if (!name) return err("Enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.");
    if (pw.length < 10 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return err("The password needs at least 10 characters, with a letter and a number.");
    if (ctx.store.state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return err("An account with this email exists already. Log in instead.");
    const user = { id: ctx.store.newId(), name, email, role: "Administrator", active: true };
    ctx.store.state.users.push(user);
    ctx.store.state.onboarded = false;
    ctx.store.audit("create", "user", `${email} (sign-up)`);
    ctx.store.login(email);
    ctx.store.save();
    ctx.go("onboarding");
  });
}
