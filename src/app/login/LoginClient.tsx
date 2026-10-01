"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeCallbackPath } from "@/lib/safeRedirect";

export default function LoginClient() {
  const sp = useSearchParams();
  // Only internal paths are honored (no open redirect); see src/lib/safeRedirect.ts.
  const callbackUrl = safeCallbackPath(sp.get("callbackUrl"));
  const passwordChanged = sp.get("passwordChanged") === "1";

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

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm border rounded-xl p-6 bg-white">
        <h1 className="text-xl font-semibold mb-4">Sign in</h1>
        {passwordChanged && !err && (
          <div className="text-sm text-green-700 mb-3">Password changed. Please sign in again.</div>
        )}
        {err && <div className="text-sm text-red-600 mb-3" role="alert">{err}</div>}

        <label className="block text-sm mb-1" htmlFor="email">Email</label>
        <input
          id="email"
          className="w-full border rounded-md px-3 py-2 mb-3"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
        />

        <label className="block text-sm mb-1" htmlFor="password">Password</label>
        <input
          id="password"
          className="w-full border rounded-md px-3 py-2 mb-4"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          autoComplete="current-password"
        />

        <button type="submit" className="w-full bg-black text-white rounded-md py-2 disabled:opacity-60" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>

        <div className="text-sm text-gray-600 mt-4">
          New here?{" "}
          <Link className="underline" href="/signup">
            Create an account
          </Link>
        </div>
      </form>
    </div>
  );
}
