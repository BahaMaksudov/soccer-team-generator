"use client";

import Link from "next/link";
import { useState } from "react";
import { signIn } from "next-auth/react";

type Invite = { token: string; email: string; organizationName: string } | null;

function firstError(data: unknown): string {
  const d = data as { error?: string; issues?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } };
  const field = d?.issues?.fieldErrors && Object.values(d.issues.fieldErrors).flat()[0];
  return field || d?.issues?.formErrors?.[0] || d?.error || "Sign up failed. Please try again.";
}

export default function SignupClient({ invite, next = null }: { invite: Invite; next?: string | null }) {
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

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm border rounded-xl p-6 bg-white">
        <h1 className="text-xl font-semibold mb-1">Create your account</h1>
        {invite ? (
          <p className="text-sm text-gray-600 mb-4">
            You were invited to join <span className="font-medium">{invite.organizationName}</span>.
          </p>
        ) : (
          <p className="text-sm text-gray-600 mb-4">Organize your pickup games and generate balanced teams.</p>
        )}
        {err && <div className="text-sm text-red-600 mb-3" role="alert">{err}</div>}

        <label className="block text-sm mb-1" htmlFor="name">Name</label>
        <input id="name" className="w-full border rounded-md px-3 py-2 mb-3" value={name}
          onChange={(e) => setName(e.target.value)} autoComplete="name" required />

        <label className="block text-sm mb-1" htmlFor="email">Email</label>
        <input id="email" type="email" className="w-full border rounded-md px-3 py-2 mb-3 read-only:bg-gray-100"
          value={email} onChange={(e) => setEmail(e.target.value)} readOnly={!!invite} autoComplete="email" required />

        <label className="block text-sm mb-1" htmlFor="password">Password</label>
        <input id="password" type="password" className="w-full border rounded-md px-3 py-2 mb-1" value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        <div className="text-xs text-gray-500 mb-3">At least 8 characters.</div>

        <label className="block text-sm mb-1" htmlFor="confirmPassword">Confirm password</label>
        <input id="confirmPassword" type="password" className="w-full border rounded-md px-3 py-2 mb-4"
          value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />

        <button type="submit" className="w-full bg-black text-white rounded-md py-2 disabled:opacity-60" disabled={loading}>
          {loading ? "Creating account..." : "Create account"}
        </button>

        <div className="text-sm text-gray-600 mt-4">
          Already have an account?{" "}
          <Link className="underline" href={invite ? `/login?callbackUrl=${encodeURIComponent(`/invite/${invite.token}`)}` : "/login"}>
            Sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
