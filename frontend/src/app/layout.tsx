import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "HEALTH-11 · Emergency Evac Graph",
  description: "Plan hospital evacuations before an emergency happens, and see the safest route when one does.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
