// Where to go after logging in. Only paths on this site are accepted, so a
// crafted link cannot send people to another website (open redirect).

export const HOME_PATH = "/dashboard";

export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return HOME_PATH;
  if (/[\u0000-\u001f]/.test(value)) return HOME_PATH;
  if (value === "/login" || value.startsWith("/login?") || value === "/register") return HOME_PATH;
  return value;
}

/** Pages anyone can open without logging in. */
export const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/forgot-password"]);
