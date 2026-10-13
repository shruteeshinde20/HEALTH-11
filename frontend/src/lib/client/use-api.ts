"use client";

// Load data from the API with loading and error states, cancelling stale
// requests. State only changes when a request finishes; "loading" is derived
// from whether the latest request has answered yet.

import { useCallback, useEffect, useState } from "react";

import { apiRequest, type Query } from "./api.ts";

export type Loadable<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
};

type Settled<T> = { key: string | null; data: T | null; error: unknown };

export function useApi<T>(path: string | null, query?: Query): Loadable<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: null, data: null, error: null });
  const queryKey = JSON.stringify(query ?? {});
  const key = path === null ? null : `${path}|${queryKey}|${attempt}`;

  useEffect(() => {
    if (path === null || key === null) return;
    const controller = new AbortController();
    apiRequest<T>(path, { query: JSON.parse(queryKey) as Query, signal: controller.signal }).then(
      (data) => setSettled({ key, data, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key, data: null, error });
      },
    );
    return () => controller.abort();
  }, [path, queryKey, key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = key !== null && settled.key === key;
  return {
    data: settled.data,
    error: current ? settled.error : null,
    loading: key !== null && !current,
    reload,
  };
}
