"use client";

import { useState } from "react";
import { Field, SubmitButton } from "@/components/auth/fields";
import { FormAlert, SuccessNote, TextLink } from "@/components/auth/parts";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/password/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDone(data?.message ?? "Check your inbox.");
      else setErr(data?.error ?? "Something went wrong. Please try again.");
    } catch {
      setErr("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {done ? (
        <SuccessNote>{done}</SuccessNote>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {err && <FormAlert>{err}</FormAlert>}
          <Field id="email" label="Email address" type="email" inputMode="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <SubmitButton loading={loading} loadingText="Sending…">
            Send reset link
          </SubmitButton>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Remembered it? <TextLink href="/login">Back to Sign In</TextLink>
      </p>
    </>
  );
}
