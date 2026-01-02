"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginPage() {
  const sp = useSearchParams();
  const callbackUrl = sp.get("callbackUrl") || "/admin";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="w-full max-w-sm border rounded-xl p-6 bg-white">
        <h1 className="text-xl font-semibold mb-4">Admin Login</h1>
        {err && <div className="text-sm text-red-600 mb-3">{err}</div>}

        <label className="block text-sm mb-1">Email</label>
        <input
          className="w-full border rounded-md px-3 py-2 mb-3"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@yourteam.com"
          autoComplete="username"
        />

        <label className="block text-sm mb-1">Password</label>
        <input
          className="w-full border rounded-md px-3 py-2 mb-4"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your admin password"
          autoComplete="current-password"
        />

        <button
          className="w-full bg-black text-white rounded-md py-2 disabled:opacity-60"
          disabled={loading}
          onClick={async () => {
            setErr(null);
            setLoading(true);
            // Use redirect=false so we can detect errors reliably
            const res = await signIn("credentials", { email, password, redirect: false, callbackUrl });
            setLoading(false);
            if (!res) {
              setErr("Login failed. Please try again.");
              return;
            }
            if (res.error) {
              setErr("Invalid email or password.");
              return;
            }
            // Navigate manually
            window.location.href = res.url ?? "/admin";
          }}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>

        <div className="text-xs text-gray-500 mt-4">Only admins can manage players and publish teams.</div>
      </div>
    </div>
  );
}
