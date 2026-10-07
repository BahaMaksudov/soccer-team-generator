"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, RotateCcw, Share2 } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/game-day/parts";
import Dialog from "@/components/app/Dialog";

/**
 * M9.3 — Share Match (OWNER/ADMIN): the Match Link players use without
 * Telegram or an account — attendance before the game, then teams, result,
 * Player of the Match and recap on the same link. Copy any number of times
 * (deterministic until Reset); Share uses the device share sheet when
 * available; Reset invalidates the previous link (confirmation). Nothing is
 * sent from here.
 */
type Share =
  | { available: true; path: string; message: { title: string; when: string; venue: string | null } }
  | { available: false; reason: "not_configured" | "private"; error: string };

export function shareText(message: { title: string; when: string; venue: string | null }, url: string): string {
  return [message.title, message.when, message.venue, "", "Let us know if you're playing:", url].filter((l) => l !== null).join("\n");
}

export default function ShareMatchCard({ organizationSlug, groupSlug, matchId }: { organizationSlug: string; groupSlug: string; matchId: string }) {
  const api = useCallback((path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${matchId}/share${path}` }), [organizationSlug, groupSlug, matchId]);
  const [share, setShare] = useState<Share | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(api(""), { cache: "no-store" });
    const data = await res.json().catch(() => null);
    setShare(data && typeof data.available === "boolean" ? data : { available: false, reason: "not_configured", error: data?.error ?? "Couldn't load the match link." });
  }, [api]);
  useEffect(() => {
    load();
    setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, [load]);

  const url = share?.available ? `${window.location.origin}${share.path}` : "";
  const text = share?.available ? shareText(share.message, url) : "";

  async function copy(value: string, done: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(done);
    } catch {
      setStatus("Couldn't copy automatically — select the text below and copy it.");
    }
  }

  async function nativeShare() {
    if (!share?.available) return;
    try {
      await navigator.share({ title: share.message.title, text: shareText(share.message, "").trimEnd(), url });
    } catch {
      /* dismissed */
    }
  }

  async function reset() {
    setConfirmReset(false);
    setBusy(true);
    try {
      const res = await fetch(api("/reset"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShare(typeof data.available === "boolean" ? data : null);
        setStatus("Link reset. The previous link no longer works — share the new one.");
      } else setStatus(data?.error ?? "Couldn't reset the link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard id="share" title="Share Match" icon={<Link2 className="size-5" />} meta="One link for attendance, teams, result and recap. No app or account needed.">
      {!share && <p className="text-sm text-muted-foreground">Loading…</p>}
      {share && !share.available && <p className="rounded-tbp border border-border bg-secondary px-3 py-2 text-sm">{share.error}</p>}
      {share?.available && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => copy(url, "Match link copied.")}>
              <Copy aria-hidden="true" /> Copy Match Link
            </Button>
            {canNativeShare && (
              <Button type="button" variant="outline" onClick={nativeShare}>
                <Share2 aria-hidden="true" /> Share
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => copy(text, "Message copied.")}>
              <Copy aria-hidden="true" /> Copy message
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
              <RotateCcw aria-hidden="true" /> Reset Link
            </Button>
          </div>
          <label className="block text-xs font-semibold text-muted-foreground" htmlFor="share-message">
            Message to paste into SMS, WhatsApp, email or any chat
          </label>
          <textarea
            id="share-message"
            readOnly
            rows={6}
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded-tbp-md border border-input bg-card p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">Anyone with the link can answer for a player of this match, so share it with your players only. Your attendance changes always take priority.</p>
        </div>
      )}
      {status && (
        <p role="status" className="mt-3 text-sm font-semibold text-primary">
          {status}
        </p>
      )}
      <Dialog open={confirmReset} title="Reset the match link?" onClose={() => setConfirmReset(false)}>
        <p className="text-sm text-muted-foreground">The link you already shared will stop working immediately. You&apos;ll need to send the new link to your players. Answers already given are kept.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setConfirmReset(false)}>
            Keep current link
          </Button>
          <Button type="button" onClick={reset}>
            Reset link
          </Button>
        </div>
      </Dialog>
    </SectionCard>
  );
}
