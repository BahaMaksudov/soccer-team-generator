"use client";

import { useEffect, useState } from "react";
import { MailX } from "lucide-react";
import { Card, MatchPageShell } from "@/components/match-link/MatchView";
import { focusRing } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";

/**
 * M13B P3 — the unsubscribe confirmation page. Shows which organization's match
 * invitation emails and which (masked) address; nothing changes until the recipient
 * presses "Unsubscribe". Account and password emails are not affected.
 */
type Preview = { state: "valid" | "used"; organizationName: string; maskedEmail: string } | { state: "expired" | "invalid" };

export default function UnsubscribeView() {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "");
    if (t) window.history.replaceState(null, "", "/unsubscribe"); // keep the token out of the address bar
    setToken(t || null);
    if (!t) return setPreview({ state: "invalid" });
    fetch("/api/email/unsubscribe/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }), cache: "no-store" })
      .then((r) => r.json())
      .then((d: Preview) => setPreview(d?.state ? d : { state: "invalid" }))
      .catch(() => setError("Could not load this page. Please try again."));
  }, []);

  async function confirm() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/email/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDone(true);
      else setError(typeof data.error === "string" ? data.error : "Could not unsubscribe. Please try again.");
    } catch {
      setError("Could not unsubscribe. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => <MatchPageShell>{children}</MatchPageShell>;
  if (!preview) return shell(<p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>);
  if (preview.state !== "valid" && preview.state !== "used") {
    return shell(
      <Card title={preview.state === "expired" ? "This unsubscribe link has expired" : "This unsubscribe link isn't valid"} icon={<MailX className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm text-muted-foreground">Use the unsubscribe link in a newer invitation email, or contact support@teambalancepro.com.</p>
      </Card>
    );
  }
  const ok: { state: "valid" | "used"; organizationName: string; maskedEmail: string } = preview;
  const finished = done || ok.state === "used";
  return shell(
    <>
      <header>
        <h1 className="text-2xl font-extrabold sm:text-3xl">{finished ? "You're unsubscribed" : "Unsubscribe from match invitations?"}</h1>
      </header>
      <Card title={ok.organizationName} icon={<MailX className="size-5 text-primary" aria-hidden="true" />}>
        {finished ? (
          <p className="text-sm">
            <span className="break-all font-semibold">{ok.maskedEmail}</span> won&apos;t get match invitation emails from {ok.organizationName} anymore.
          </p>
        ) : (
          <>
            <p className="text-sm">
              Stop match invitation emails from <strong>{ok.organizationName}</strong> to <span className="break-all font-semibold">{ok.maskedEmail}</span>?
            </p>
            <button type="button" disabled={busy} onClick={confirm} className={cn("mt-4 inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60", focusRing)}>
              {busy ? "Unsubscribing…" : "Unsubscribe"}
            </button>
          </>
        )}
        <p className="mt-3 text-xs text-muted-foreground">This only affects match invitation emails from this organization. Account, sign-in and password emails are not affected.</p>
      </Card>
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
