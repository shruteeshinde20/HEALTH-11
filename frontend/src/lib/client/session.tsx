"use client";

// The signed-in user for the app pages, loaded from /api/session/me (which
// renews the session if needed).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { User } from "../shared/api-types.ts";
import { ApiError } from "../shared/errors.ts";
import { sessionRequest } from "./api.ts";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; user: User }
  | { status: "error"; error: unknown };

type SessionValue = {
  state: SessionState;
  logout: () => Promise<void>;
  retry: () => void;
  updateUser: (user: User) => void;   // after the user changed their own profile
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    sessionRequest<{ user: User }>("me").then(
      ({ user }) => {
        if (active) setState({ status: "ready", user });
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          const next = window.location.pathname + window.location.search;
          // Full page load on purpose: the ended session's data must not stay in memory.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setState({ status: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  const logout = useCallback(async () => {
    try {
      await sessionRequest("logout", {});
    } finally {
      // Full page load on purpose: nothing of this user's data may stay in memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }, []);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const updateUser = useCallback((user: User) => setState({ status: "ready", user }), []);

  return <SessionContext.Provider value={{ state, logout, retry, updateUser }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** The signed-in user; only call inside AppShell, which renders pages once the user is known. */
export function useUser(): User {
  const { state } = useSession();
  if (state.status !== "ready") throw new Error("useUser called before the session was loaded");
  return state.user;
}
