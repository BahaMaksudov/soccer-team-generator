"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeCallbackPath } from "@/lib/safeRedirect";
import { authErrorMessage } from "@/lib/authErrors";
import { Field, GoogleButton, SubmitButton } from "@/components/auth/fields";
import { FormAlert, OrDivider, SuccessNote, TextLink } from "@/components/auth/parts";

export default function LoginClient({ googleEnabled }: { googleEnabled: boolean }) {
  const sp = useSearchParams();
  // Only internal paths are honored (no open redirect); see src/lib/safeRedirect.ts.
  const callbackUrl = safeCallbackPath(sp.get("callbackUrl"));
  const passwordChanged = sp.get("passwordChanged") === "1";
  // OAuth / Google outcomes come back as ?error=<code> (known codes only; never echoed).
  const oauthError = authErrorMessage(sp.get("error"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    setLoading(true);

    // Use redirect=false so we can detect errors reliably
    const res = await signIn("credentials", { email, password, redirect: false, callbackUrl });

    if (!res || res.error) {
      setLoading(false);
      // Generic on purpose: never reveals whether the email exists.
      setErr(res ? "Invalid email or password." : "Login failed. Please try again.");
      return;
    }

    // Navigate to the sanitized internal path (never an arbitrary URL).
    window.location.href = callbackUrl;
  }

  const alert = err ?? oauthError;

  return (
    <>
      {passwordChanged && !alert && (
        <div className="mb-6">
          <SuccessNote>Password changed. Please sign in again.</SuccessNote>
        </div>
      )}
      {googleEnabled && (
        <>
          <GoogleButton callbackUrl={callbackUrl} />
          <OrDivider label="or continue with email" />
        </>
      )}
      <form onSubmit={submit} className="space-y-5">
        {alert && <FormAlert>{alert}</FormAlert>}
        <Field
          id="email"
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <SubmitButton loading={loading} loadingText="Signing in…">
          Sign In
        </SubmitButton>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to Team Balance Pro? <TextLink href="/signup">Create an account</TextLink>
      </p>
    </>
  );
}
