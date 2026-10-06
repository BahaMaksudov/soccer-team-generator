"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { PASSWORD_MIN_LENGTH } from "@/lib/passwordRules";
import { Field, GoogleButton, SubmitButton } from "@/components/auth/fields";
import { FormAlert, FormHead, OrDivider, TextLink } from "@/components/auth/parts";

type Invite = { token: string; email: string; organizationName: string } | null;

function firstError(data: unknown): string {
  const d = data as { error?: string; issues?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } };
  const field = d?.issues?.fieldErrors && Object.values(d.issues.fieldErrors).flat()[0];
  return field || d?.issues?.formErrors?.[0] || d?.error || "Sign up failed. Please try again.";
}

export default function SignupClient({ invite, next = null, googleEnabled = false }: { invite: Invite; next?: string | null; googleEnabled?: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invite?.email ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    if (password !== confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          invite
            ? { name, password, confirmPassword, inviteToken: invite.token }
            : { name, email, password, confirmPassword, ...(next ? { next } : {}) }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(firstError(data));
        setLoading(false);
        return;
      }
      // Signed in but unverified: the next stop is "Check your email" (resend lives there).
      const params = new URLSearchParams();
      if (typeof data.next === "string" && data.next) params.set("next", data.next);
      if (data.verificationEmailSent === false) params.set("sent", "0");
      const qs = params.toString();
      const checkEmail = `/verify-email${qs ? `?${qs}` : ""}`;
      const login = await signIn("credentials", { email: data.email, password, redirect: false, callbackUrl: checkEmail });
      window.location.href = !login || login.error ? `/login?callbackUrl=${encodeURIComponent(checkEmail)}` : checkEmail;
    } catch {
      setErr("Sign up failed. Please try again.");
      setLoading(false);
    }
  }

  // Google: a verified Google email needs no verification email. Invitations
  // still go through /invite/<token> (acceptance checks the invited email).
  const googleCallback = invite ? `/invite/${invite.token}` : next || "/admin";

  return (
    <>
      <FormHead
        title="Create your account"
        body={
          invite ? (
            <>
              You were invited to join <span className="font-semibold text-foreground">{invite.organizationName}</span>.
            </>
          ) : (
            "Start organizing fairer, easier game days."
          )
        }
      />
      {googleEnabled && (
        <>
          <GoogleButton callbackUrl={googleCallback} />
          <OrDivider label="or create an account with email" />
        </>
      )}
      <form onSubmit={submit} className="space-y-5">
        {err && <FormAlert>{err}</FormAlert>}
        <Field id="name" label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Field
          id="email"
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={!!invite}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={PASSWORD_MIN_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          required
        />
        <Field
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
        <SubmitButton loading={loading} loadingText="Creating account…">
          Create Account
        </SubmitButton>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <TextLink href={invite ? `/login?callbackUrl=${encodeURIComponent(`/invite/${invite.token}`)}` : "/login"}>Sign in</TextLink>
      </p>
    </>
  );
}
