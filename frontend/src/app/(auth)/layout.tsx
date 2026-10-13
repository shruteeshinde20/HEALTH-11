import type { ReactNode } from "react";

import { SAFETY_NOTICE } from "@/lib/shared/pages.ts";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col px-4">
      <main id="main" className="flex-1">{children}</main>
      <footer className="mx-auto mb-4 w-full max-w-[1100px]">
        <p className="note">{SAFETY_NOTICE}</p>
      </footer>
    </div>
  );
}
