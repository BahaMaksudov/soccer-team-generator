import AuthLayout from "@/components/auth/AuthLayout";
import { FormHead } from "@/components/auth/parts";
import ForgotPasswordForm from "./ForgotPasswordForm";

/** M11.3 — "Forgot password" (public). The answer never reveals whether an account exists. */
export const metadata = { title: "Reset your password — TeamBalance Pro" };

export default function ForgotPasswordPage() {
  return (
    <AuthLayout headline="Back in the game in a minute." body="We'll email you a link to choose a new password.">
      <FormHead title="Forgot your password?" body="Enter the email address of your account. If it has a password, we'll send a reset link." />
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
