// Content-Security-Policy for the website's pages (Next.js nonce approach:
// https://nextjs.org/docs/app/guides/content-security-policy). Pure, unit-tested.

export type CspOptions = {
  nonce: string;
  development: boolean;      // React needs eval and inline styles while developing
  secure: boolean;           // served over HTTPS: upgrade any http:// request
  streamOrigin: string | null;  // where live-simulation WebSockets go, e.g. ws://127.0.0.1:8000
};

/** A fresh random nonce for one response. */
export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

/** The origin (scheme://host:port) of a ws:// or wss:// URL, or null. */
export function wsOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function buildCsp({ nonce, development, secure, streamOrigin }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // Only scripts carrying this response's nonce (and what they load) run.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // <style> elements need the nonce; style="" attributes (React, React Flow,
    // charts) are allowed. In development Next.js injects styles without one.
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${streamOrigin ? ` ${streamOrigin}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
