import type { Metadata } from "next";

import { safeNextPath } from "@/lib/shared/navigation.ts";

import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Log in · HEALTH-11" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={safeNextPath(typeof next === "string" ? next : null)} />;
}
