"use client";

import { useState } from "react";
import { Field, SubmitButton } from "@/components/auth/fields";
import { FormAlert, TextLink } from "@/components/auth/parts";
import { PASSWORD_MIN_LENGTH } from "@/lib/passwordRules";

type Issues = { fieldErrors?: Record<string, string[] | undefined> };

export default function ResetPasswordForm({ token }: { token: string }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ newPassword?: string; confirmPassword?: string }>({});
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    setFieldErr({});
    if (newPassword !== confirmPassword) return setFieldErr({ confirmPassword: "Passwords do not match." });
    setLoading(true);
    try {
      const res = await fetch("/api/password/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword, confirmPassword }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: Issues };
      if (res.ok) {
        window.location.href = "/login?passwordReset=1";
        return;
      }
      const f = data.issues?.fieldErrors ?? {};
      if (f.newPassword?.[0] || f.confirmPassword?.[0]) setFieldErr({ newPassword: f.newPassword?.[0], confirmPassword: f.confirmPassword?.[0] });
      else setErr(data.error ?? "Could not reset the password.");
    } catch {
      setErr("Could not reset the password.");
    }
    setLoading(false);
  }

  return (
    <>
      <form onSubmit={submit} className="space-y-5">
        {err && <FormAlert>{err}</FormAlert>}
        <Field id="newPassword" label="New password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={fieldErr.newPassword} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        <Field id="confirmPassword" label="Confirm new password" type="password" autoComplete="new-password" error={fieldErr.confirmPassword} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        <SubmitButton loading={loading} loadingText="Saving…">
          Set new password
        </SubmitButton>
      </form>
      {err && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          <TextLink href="/forgot-password">Request a new link</TextLink>
        </p>
      )}
    </>
  );
}
