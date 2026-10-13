import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell.tsx";
import { SessionProvider } from "@/lib/client/session.tsx";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
