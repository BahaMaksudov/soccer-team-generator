"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";

/**
 * M13B P2 — email invitation RECIPIENT PREVIEW (OWNER/ADMIN; website-only matches).
 * Read-only: shows who would receive an RSVP email, masked destinations and why
 * others are excluded, plus the organization's allowance. Email sending is not
 * available yet — the Send button is disabled and does nothing.
 * Hidden for Telegram matches (they are answered in the poll).
 */
type Status = "WILL_SEND" | "NO_EMAIL" | "INVALID_CONTACT" | "ALREADY_ANSWERED" | "ORGANIZER_OVERRIDE" | "NOT_ON_ROSTER" | "SUPPRESSED" | "OVER_LIMIT";
type Row = { playerId: string; name: string; status: Status; source: "PLAYER" | "GUARDIAN" | "ACCOUNT" | null; maskedEmail: string | null };
type Preview = {
  recipients: Row[];
  notOnRoster: Array<{ playerId: string; name: string }>;
  counts: { willSend: number; excluded: number };
  allowance: { plan: string; day: { limit: number }; month: { limit: number }; usage: { available: false; note: string } };
};

export const STATUS_LABEL: Record<Status, string> = {
  WILL_SEND: "Will be invited",
  NO_EMAIL: "No email address",
  INVALID_CONTACT: "Contact email needs fixing",
  ALREADY_ANSWERED: "Already answered",
  ORGANIZER_OVERRIDE: "Status set by organizer",
  NOT_ON_ROSTER: "Not on this match's roster",
  SUPPRESSED: "Not receiving invitation emails",
  OVER_LIMIT: "Beyond plan ceiling (provisional)",
};
const SOURCE_LABEL = { PLAYER: "Player", GUARDIAN: "Parent / Guardian", ACCOUNT: "Linked account (verified)" } as const;

export default function RsvpPreviewCard({ organizationSlug, groupSlug, matchId }: { organizationSlug: string; groupSlug: string; matchId: string }) {
  const url = adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}/rsvp-preview` });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<{ code: string; error: string } | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setPreview(data as Preview);
      setRefusal(null);
    } else if (data?.code === "TELEGRAM_MATCH" || res.status === 404) setHidden(true);
    else setRefusal({ code: String(data?.code ?? "ERROR"), error: typeof data?.error === "string" ? data.error : "Could not load the preview." });
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);

  if (hidden || (!preview && !refusal)) return null;
  return (
    <SectionCard id="rsvp-preview" title="Email invitations (preview)" icon={<Mail className="size-5" />} meta="Who would get an RSVP email for this match. Email sending isn't available yet — nothing is sent from here.">
      {refusal ? (
        <p className="text-sm text-muted-foreground">{refusal.error}</p>
      ) : (
        preview && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-tbp-md border border-border p-2">
                <dt className="text-xs text-muted-foreground">Would be invited</dt>
                <dd className="text-lg font-extrabold tabular-nums">{preview.counts.willSend}</dd>
              </div>
              <div className="rounded-tbp-md border border-border p-2">
                <dt className="text-xs text-muted-foreground">Excluded</dt>
                <dd className="text-lg font-extrabold tabular-nums">{preview.counts.excluded}</dd>
              </div>
              <div className="rounded-tbp-md border border-border p-2">
                <dt className="text-xs text-muted-foreground">Daily plan ceiling</dt>
                <dd className="text-lg font-extrabold tabular-nums">{preview.allowance.day.limit}</dd>
              </div>
              <div className="rounded-tbp-md border border-border p-2">
                <dt className="text-xs text-muted-foreground">Monthly plan ceiling</dt>
                <dd className="text-lg font-extrabold tabular-nums">{preview.allowance.month.limit}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">{preview.allowance.usage.note}</p>
            <ul className="divide-y divide-border">
              {preview.recipients.map((r) => (
                <li key={r.playerId} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0">
                    <span className="block break-words font-semibold">{r.name}</span>
                    <span className="block break-all text-xs text-muted-foreground">{r.maskedEmail ?? "—"}</span>
                    {r.source && <span className="block text-xs text-muted-foreground">{SOURCE_LABEL[r.source]}</span>}
                  </span>
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", r.status === "WILL_SEND" ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground")}>{STATUS_LABEL[r.status]}</span>
                </li>
              ))}
            </ul>
            {preview.notOnRoster.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer font-semibold">Not on this match&apos;s roster ({preview.notOnRoster.length}) — never invited</summary>
                <p className="mt-1 text-xs text-muted-foreground">{preview.notOnRoster.map((p) => p.name).join(", ")}</p>
              </details>
            )}
            <div>
              <Button type="button" disabled aria-disabled="true" title="Email sending isn't available yet">
                Send invitations — coming soon
              </Button>
            </div>
          </div>
        )
      )}
    </SectionCard>
  );
}
