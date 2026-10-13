import type { Metadata } from "next";

import { RegisterForm } from "./register-form.tsx";

export const metadata: Metadata = { title: "Create an account · HEALTH-11" };

export default function RegisterPage() {
  return <RegisterForm />;
}
