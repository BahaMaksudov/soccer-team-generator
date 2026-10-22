"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Users } from "lucide-react";
import { Card, MatchPageShell } from "@/components/match-link/MatchView";
import { focusRing } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";

/**
 * M13A — the group invitation page. Shows the Group's name only (never its
 * roster). Signed-in users with a verified email can ASK to join; an organizer
 * approves or rejects every request.
 *
 * The token arrives in the URL fragment. Sign-in / sign-up / email verification
 * return to plain "/join" — the token is never put into a callback URL. To
 * survive that round trip it is kept in this browser's localStorage for at most
 * one hour (also across the tab the verification email opens), removed from the
 * address bar, and deleted as soon as the request is filed or the link turns
 * out to be unusable.
 */
type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
type Preview =
  | { state: "invalid" | "expired" | "revoked" }
  | {
      state: "valid";
      group: { name: string; organizationName: string; sportLabel: string };
      viewer: null | { emailVerified: boolean; email: string; name: string | null; member: boolean; request: { id: string; status: RequestStatus; createdAt: string } | null };
    };

export const JOIN_STORAGE_KEY = "tbp:join-invite";
const STORAGE_TTL_MS = 60 * 60_000;
const HERE = "/join";

export function rememberToken(token: string, now = Date.now()) {
  try {
    window.localStorage.setItem(JOIN_STORAGE_KEY, JSON.stringify({ t: token, exp: now + STORAGE_TTL_MS }));
  } catch {
    /* storage unavailable: the link still works when reopened */
  }
}
export function recallToken(now = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(JOIN_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { t?: unknown; exp?: unknown };
    if (typeof v.t === "string" && typeof v.exp === "number" && v.exp > now) return v.t;
    window.localStorage.removeItem(JOIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return null;
}
export function forgetToken() {
  try {
    window.localStorage.removeItem(JOIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const DEAD: Record<"invalid" | "expired" | "revoked", { title: string; body: string }> = {
  invalid: { title: "This invite link isn't valid", body: "Check that you copied the whole link, or ask your organizer for a new one." },
  expired: { title: "This invite link has expired", body: "Ask your organizer for a new invite link." },
  revoked: { title: "This invite link is no longer active", body: "Your organizer turned this link off. Ask them for a new invite link." },
};

const primaryBtn = cn("inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60", focusRing);
const outlineBtn = cn("inline-flex min-h-11 items-center justify-center rounded-full border border-input bg-card px-5 text-sm font-semibold hover:bg-muted", focusRing);
const input = cn("mt-1 block min-h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base", focusRing);

export default function JoinGroupPage() {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(t: string) {
    try {
      const res = await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }), cache: "no-store" });
      const data = (await res.json().catch(() => null)) as Preview | { error?: string } | null;
      if (res.status === 429) return setError((data as { error?: string })?.error ?? "Too many requests. Please try again in a few minutes.");
      const p: Preview = data && "state" in data ? data : { state: "invalid" };
      setPreview(p);
      if (p.state !== "valid" || p.viewer?.member || p.viewer?.request?.status === "PENDING" || p.viewer?.request?.status === "APPROVED") forgetToken();
      if (p.state === "valid" && p.viewer?.name && !firstName && !lastName) {
        const [first, ...rest] = p.viewer.name.trim().split(/\s+/);
        setFirstName(first ?? "");
        setLastName(rest.join(" "));
      }
    } catch {
      setError("Could not load the invitation. Please try again.");
    }
  }

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, "");
    let t: string | null = fromHash || null;
    if (fromHash) {
      rememberToken(fromHash);
      // Keep the token out of the address bar (screenshots, shoulder-surfing); reloads use the stored copy.
      window.history.replaceState(null, "", HERE);
    } else t = recallToken();
    setToken(t);
    if (!t) return setPreview({ state: "invalid" });
    void load(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/join/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, firstName, lastName }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok && res.status !== 409) setError(data.error ?? "Could not send your request.");
      await load(token);
    } catch {
      setError("Could not send your request.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(requestId: string) {
    if (!token || busy) return;
    setBusy(true);
    try {
      await fetch("/api/join/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) });
      rememberToken(token);
      await load(token);
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => <MatchPageShell>{children}</MatchPageShell>;
  if (!preview) return shell(<p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>);
  if (preview.state !== "valid") {
    const d = DEAD[preview.state];
    return shell(
      <div className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <h1 className="text-xl font-extrabold">{d.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{d.body}</p>
      </div>
    );
  }

  const { group, viewer } = preview;
  const request = viewer?.request ?? null;
  let body: React.ReactNode;
  if (!viewer) {
    body = (
      <Card id="join" title="Sign in to request to join" icon={<Users className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm">Sign in or create a free account — then come back here to send your request. You can use Google or your email address.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className={primaryBtn} href={`/login?callbackUrl=${encodeURIComponent(HERE)}`}>
            Sign in
          </Link>
          <Link className={outlineBtn} href={`/signup?next=${encodeURIComponent(HERE)}`}>
            Create an account
          </Link>
        </div>
      </Card>
    );
  } else if (!viewer.emailVerified) {
    body = (
      <Card id="join" title="Verify your email first" icon={<Users className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm">Confirm your email address ({viewer.email}), then come back to this page to send your request.</p>
        <div className="mt-4">
          <Link className={primaryBtn} href={`/verify-email?next=${encodeURIComponent(HERE)}`}>
            Verify email
          </Link>
        </div>
      </Card>
    );
  } else if (viewer.member || request?.status === "APPROVED") {
    body = (
      <Card id="join" title="You're a member of this group" icon={<CheckCircle2 className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm">Your account is connected to a player in {group.name}. Your upcoming games are on My Games.</p>
        <div className="mt-4">
          <Link className={primaryBtn} href="/me">
            Go to My Games
          </Link>
        </div>
      </Card>
    );
  } else if (request?.status === "PENDING") {
    body = (
      <Card id="join" title="Waiting for approval" icon={<Clock className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm">Your request was sent. The organizer will review it — once approved, the group&apos;s games appear on My Games.</p>
        <p className="mt-2 text-xs text-muted-foreground">Signed in as {viewer.email}.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className={outlineBtn} href="/me">
            My Games
          </Link>
          <button type="button" className={outlineBtn} disabled={busy} onClick={() => cancel(request.id)}>
            Cancel request
          </button>
        </div>
      </Card>
    );
  } else {
    body = (
      <Card id="join" title="Request to join" icon={<Users className="size-5 text-primary" aria-hidden="true" />}>
        {request?.status === "REJECTED" && <p className="mb-3 text-sm text-muted-foreground">Your earlier request wasn&apos;t approved. Contact the organizer if you think this is a mistake — you can send a new request below.</p>}
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm">Tell the organizer who you are. They&apos;ll connect your account to your player profile.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              First name
              <input className={input} value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={60} required autoComplete="given-name" />
            </label>
            <label className="block text-sm font-semibold">
              Last name
              <input className={input} value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={60} required autoComplete="family-name" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">Signed in as {viewer.email}. The organizer sees your name and this email address.</p>
          <button type="submit" className={primaryBtn} disabled={busy || !firstName.trim() || !lastName.trim()}>
            {busy ? "Sending…" : "Send request"}
          </button>
        </form>
      </Card>
    );
  }

  return shell(
    <>
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-accent">
          {group.organizationName} · {group.sportLabel}
        </p>
        <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">Join {group.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">You&apos;ve been invited to join this group on TeamBalance Pro. The organizer approves every request.</p>
      </header>
      {body}
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      <p className="text-center text-xs text-muted-foreground">Joining doesn&apos;t give you organizer access. Attendance for Telegram groups still happens in the Telegram poll.</p>
    </>
  );
}
