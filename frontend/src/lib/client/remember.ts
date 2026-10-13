// Remembers the last organization ID typed on this device, for convenience
// only. Browser storage can be unavailable (private mode), so failures are ignored.

const KEY = "health11.organization";

export function rememberedOrganization(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberOrganization(slug: string): void {
  try {
    window.localStorage.setItem(KEY, slug);
  } catch {
    // Not available: nothing to remember.
  }
}
