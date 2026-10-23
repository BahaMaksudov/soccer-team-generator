"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * M13B P1 — a Player's organizer-entered contact email (OWNER/ADMIN only; the API
 * answers 404 for other roles). Loaded when the player's details open, so rosters
 * never carry addresses. The contact is the player's own address or a parent /
 * guardian's. A linked account's verified email is never overwritten or shown here
 * — only whether one exists (it is the fallback for future invitations).
 * Nothing is sent from here.
 *
 * M13B P6 — saving a new or changed contact asks the organizer to confirm the address may
 * be used for match coordination email (recorded with who and when). The wording is an
 * attestation by the organizer — it doesn't claim to be a parent / guardian's legal consent.
 * An unconfirmed contact never receives invitations.
 */
type ContactType = "PLAYER" | "GUARDIAN";
type View = { contact: { email: string; type: ContactType; updatedAt: string | null; authorization: { at: string; byName: string | null } | null } | null; linkedAccount: { linked: boolean; verified: boolean } };

export const AUTHORIZATION_TEXT: Record<ContactType, string> = {
  PLAYER: "I confirm this player gave me this address, or agreed to its use, for match coordination emails (invitations to RSVP for matches).",
  GUARDIAN: "I confirm this parent / guardian gave me this address, or agreed to its use, for match coordination emails about this player (invitations to RSVP for matches).",
};

const control = "block min-h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export default function PlayerContactCell({ organizationSlug, groupSlug, playerId, onMessage }: { organizationSlug: string; groupSlug: string; playerId: string; onMessage: (msg: string | null) => void }) {
  const url = adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${encodeURIComponent(playerId)}/contact` });
  const uid = useId();
  const [view, setView] = useState<View | null>(null);
  const [email, setEmail] = useState("");
  const [type, setType] = useState<ContactType>("PLAYER");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const apply = useCallback((v: View) => {
    setView(v);
    setEmail(v.contact?.email ?? "");
    setType(v.contact?.type ?? "PLAYER");
    setAuthorized(false);
  }, []);
  useEffect(() => {
    let live = true;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: View | null) => live && v && apply(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url, apply]);

  async function save(next: { email: string | null; type?: ContactType; authorized?: true }) {
    setBusy(true);
    setError(null);
    onMessage(null);
    try {
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(typeof data.error === "string" && data.error !== "NOT_FOUND" ? data.error : "Could not save the contact email.");
      apply(data as View);
      onMessage(next.email ? "Contact email saved." : "Contact email removed.");
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const dirty = email.trim().toLowerCase() !== (view.contact?.email ?? "") || (email.trim() !== "" && type !== (view.contact?.type ?? "PLAYER"));
  // A new or materially changed contact — or one nobody confirmed yet — needs a fresh confirmation.
  const needsConfirmation = email.trim() !== "" && (dirty || !view.contact?.authorization);
  const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Optional. Used only for match coordination emails (RSVP invitations). Only organizers can see it — never other players or public pages. Recipients can unsubscribe from any invitation.</p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(email.trim() ? { email, type, ...(needsConfirmation ? { authorized: true as const } : {}) } : { email: null });
        }}
      >
        <div>
          <label htmlFor={`${uid}-email`} className="mb-1 block text-xs font-semibold">
            Contact email
          </label>
          <input
            id={`${uid}-email`}
            type="email"
            inputMode="email"
            autoComplete="off"
            maxLength={254}
            className={control}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-error` : undefined}
          />
        </div>
        <fieldset>
          <legend className="mb-1 text-xs font-semibold">Whose email is this?</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {(
              [
                ["PLAYER", "Player"],
                ["GUARDIAN", "Parent / Guardian"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="inline-flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name={`${uid}-type`} value={value} checked={type === value} onChange={() => setType(value)} className="size-4" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {needsConfirmation && (
          <label className="flex items-start gap-2 rounded-tbp-md border border-border p-2 text-xs">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
            <span>
              {AUTHORIZATION_TEXT[type]} <span className="text-muted-foreground">TeamBalance Pro records that you confirmed this (who and when). It isn&apos;t verified and isn&apos;t a legal consent record.</span>
            </span>
          </label>
        )}
        {view.contact && !dirty && (
          <p className={cn("text-xs", view.contact.authorization ? "text-muted-foreground" : "font-semibold text-destructive")}>
            {view.contact.authorization
              ? `Confirmed for match emails by ${view.contact.authorization.byName ?? "an organizer"} on ${when(view.contact.authorization.at)}.`
              : "Not confirmed yet — this address won't receive invitations until you confirm it."}
          </p>
        )}
        {error && (
          <p id={`${uid}-error`} role="alert" className="text-xs font-semibold text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || !(dirty || needsConfirmation) || (needsConfirmation && !authorized)}>
            {busy ? "Saving…" : "Save contact"}
          </Button>
          {view.contact && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save({ email: null })}>
              Remove
            </Button>
          )}
        </div>
      </form>
      <p className={cn("text-xs", view.linkedAccount.verified ? "text-foreground" : "text-muted-foreground")}>
        {view.linkedAccount.linked
          ? view.linkedAccount.verified
            ? "Linked account: verified email on file (used for invitations when no contact email is set). It is kept separate and never changed here."
            : "Linked account: email not verified — it won't be used for invitations."
          : "No linked account."}
      </p>
    </div>
  );
}
