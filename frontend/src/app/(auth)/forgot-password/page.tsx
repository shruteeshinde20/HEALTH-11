import type { Metadata } from "next";

import { ForgotPasswordForm } from "./forgot-form.tsx";

export const metadata: Metadata = { title: "Forgot password · HEALTH-11" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
