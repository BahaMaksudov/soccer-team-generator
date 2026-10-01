"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Preview =
  | { status: "valid"; organizationName: string; groupName: string; sportKey: string; playerName: string }
  | { status: "expired" | "used" | "invalid" | "already_claimed" };

const MESSAGES: Record<string, string> = {
  expired: "This claim link has expired. Ask the organizer for a new one.",
  used: "This claim link has already been used.",
  invalid: "This claim link is not valid.",
  already_claimed: "This player profile is already linked to an account.",
};

export default function ClaimView({ signedIn, emailVerified, email }: { signedIn: boolean; emailVerified: boolean; email: string | null }) {
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "");
    setToken(t);
    if (!t) return setPreview({ status: "invalid" });
    fetch("/api/claims/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })
      .then((r) => r.json())
      .then((d) => setPreview(d?.status ? d : { status: "invalid" }))
      .catch(() => setPreview({ status: "invalid" }));
  }, []);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/claims/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: data?.error || "Could not claim this player profile." });
        setBusy(false);
        return;
      }
      window.location.href = "/me";
    } catch {
      setMsg({ ok: false, text: "Could not claim this player profile." });
      setBusy(false);
    }
  }

  const here = `/claim#${token}`;
  return (
    <div className="max-w-md mx-auto rounded-2xl border bg-white shadow-sm p-5 space-y-3">
      <h1 className="text-xl font-semibold">Claim your player profile</h1>
      {!preview ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : preview.status !== "valid" ? (
        <p className="text-sm text-gray-600">{MESSAGES[preview.status]}</p>
      ) : (
        <>
          <p className="text-sm">
            Link <span className="font-semibold">{preview.playerName}</span> in{" "}
            <span className="font-semibold">{preview.groupName}</span> ({preview.organizationName}, {preview.sportKey}) to
            your Team Balance Pro account?
          </p>
          <p className="text-xs text-gray-500">
            This is optional — you can keep taking part through Telegram either way. It does not give you organizer access.
          </p>
          {!signedIn ? (
            <div className="flex flex-wrap gap-2">
              <Link className="bg-black text-white rounded-md px-4 py-2 text-sm" href={`/login?callbackUrl=${encodeURIComponent(here)}`}>Sign in</Link>
              <Link className="border rounded-md px-4 py-2 text-sm" href={`/signup?next=${encodeURIComponent(here)}`}>Create an account</Link>
            </div>
          ) : !emailVerified ? (
            <div className="text-sm space-y-1">
              <p>Verify your email address first, then come back to this link.</p>
              <Link className="underline" href={`/verify-email?next=${encodeURIComponent(here)}`}>Verify email</Link>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">Signed in as {email}.</p>
              <button type="button" className="bg-black text-white rounded-md px-4 py-2 text-sm disabled:opacity-60" disabled={busy} onClick={confirm}>
                {busy ? "Claiming…" : "Confirm claim"}
              </button>
            </div>
          )}
        </>
      )}
      {msg && <div className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</div>}
    </div>
  );
}
