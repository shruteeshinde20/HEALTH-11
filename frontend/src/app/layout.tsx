import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "HEALTH-11 · Emergency Evac Graph",
  description: "Plan hospital evacuations before an emergency happens, and see the safest route when one does.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request, so each gets its own CSP nonce (see src/proxy.ts).
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
