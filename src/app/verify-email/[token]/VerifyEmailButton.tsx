"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormAlert, SuccessNote } from "@/components/auth/parts";

export default function VerifyEmailButton({ token, next }: { token: string; next: string | null }) {
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function verify() {
    if (loading) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error || "Could not verify your email.");
        setLoading(false);
        return;
      }
      setDone(true);
      // `next` was sanitized server-side (internal path only).
      window.location.href = next || "/admin";
    } catch {
      setErr("Could not verify your email.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {err && <FormAlert>{err}</FormAlert>}
      {done ? (
        <SuccessNote>Email verified. Continuing…</SuccessNote>
      ) : (
        <Button size="xl" className="w-full" onClick={verify} disabled={loading} aria-busy={loading}>
          {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {loading ? "Verifying…" : "Verify email"}
        </Button>
      )}
    </div>
  );
}
