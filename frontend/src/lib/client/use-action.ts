"use client";

// Run a change (create, update, delete, upload) with busy and error states.

import { useCallback, useState } from "react";

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(caught);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
