// Server-only settings, read from environment variables at request time
// (never NEXT_PUBLIC_*, so nothing here reaches the browser).

export type ServerConfig = {
  backendUrl: string;
  trustProxyHeaders: boolean;
  secureCookies: boolean;
};

let cached: ServerConfig | null = null;

export function serverConfig(): ServerConfig {
  if (cached) return cached;
  const raw = (process.env.BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BACKEND_URL is not set to a valid URL (for example http://127.0.0.1:8000)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BACKEND_URL must start with http:// or https://");
  }
  cached = {
    backendUrl: raw,
    trustProxyHeaders: (process.env.TRUST_PROXY_HEADERS ?? "").trim().toLowerCase() === "true",
    // Browsers only send Secure cookies over HTTPS; production must use HTTPS.
    secureCookies: process.env.NODE_ENV === "production",
  };
  return cached;
}
