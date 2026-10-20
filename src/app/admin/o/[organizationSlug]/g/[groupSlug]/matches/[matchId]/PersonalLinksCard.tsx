"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, RotateCcw } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/game-day/parts";

/**
 * M12B — personal attendance links (website-only matches). Each link lets ONE
 * player answer for this match only. Links are shown ONCE right after they are
 * created (only a hash is stored) — copy and send them yourself; nothing is sent
 * automatically. "Regenerate" replaces a player's link (the old one stops
 * working); "Revoke" disables it. Telegram matches are answered in the poll.
 */
type Row = { playerId: string; name: string; link: { createdAt: string; lastUsedAt: string | null } | null; response: { status: "PLAYING" | "MAYBE" | "NOT_PLAYING" | null; source: string | null; overridden: boolean } };
type View = { mode: "telegram" | "web"; state: "open" | "closed" | "canceled"; players: Row[] };
const STATUS: Record<string, string> = { PLAYING: "Playing", MAYBE: "Maybe", NOT_PLAYING: "Not playing" };

export default function PersonalLinksCard({ organizationSlug, groupSlug, matchId }: { organizationSlug: string; groupSlug: string; matchId: string }) {
  const api = adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}/personal-links` });
  const [view, setView] = useState<View | null>(null);
  const [fresh, setFresh] = useState<Record<string, string>>({}); // playerId → absolute URL (this session only)
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(api, { cache: "no-store" });
    if (res.ok) setView((await res.json()) as View);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data?.error ?? "Something went wrong.");
        return null;
      }
      await load();
      return data;
    } finally {
      setBusy(false);
    }
  }
  async function issue(playerIds?: string[]) {
    const data = await post({ action: "issue", ...(playerIds ? { playerIds } : {}) });
    if (!data) return;
    const next: Record<string, string> = {};
    for (const l of data.links as Array<{ playerId: string; path: string }>) next[l.playerId] = `${window.location.origin}${l.path}`;
    setFresh((f) => ({ ...f, ...next }));
    setMessage(`${data.links.length} personal link${data.links.length === 1 ? "" : "s"} created. Copy and send them now — they're shown only once.`);
  }
  async function revoke(playerId: string) {
    if (await post({ action: "revoke", playerId })) {
      setFresh((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== playerId)));
      setMessage("Link revoked. It no longer works.");
    }
  }
  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(done);
    } catch {
      setMessage("Couldn't copy automatically — select the link and copy it.");
    }
  }

  if (!view) return null;
  if (view.mode === "telegram") {
    return (
      <SectionCard id="personal-links" title="Attendance" icon={<KeyRound className="size-5" />} meta="Players vote in this match's Telegram poll — that's the one attendance workflow for this match.">
        <p className="text-sm text-muted-foreground">Personal attendance links aren&apos;t used for Telegram matches. You can still set any player&apos;s status above.</p>
      </SectionCard>
    );
  }
  const names = new Map(view.players.map((p) => [p.playerId, p.name]));
  const freshList = Object.entries(fresh).filter(([id]) => names.has(id));
  const open = view.state === "open";
  return (
    <SectionCard id="personal-links" title="Personal attendance links" icon={<KeyRound className="size-5" />} meta="Each link lets one player answer for this match only. No account needed. Send them yourself — nothing is sent automatically.">
      {!open && <p className="mb-3 text-sm text-muted-foreground">Attendance is {view.state === "canceled" ? "canceled" : "closed"} — personal links no longer accept answers.</p>}
      {open && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button type="button" disabled={busy || view.players.length === 0} onClick={() => issue()}>
            {view.players.some((p) => p.link) ? "Regenerate links for everyone" : "Create links for everyone"}
          </Button>
          {freshList.length > 1 && (
            <Button type="button" variant="outline" onClick={() => copy(freshList.map(([id, url]) => `${names.get(id)}: ${url}`).join("\n"), "All new links copied.")}>
              <Copy className="size-4" aria-hidden="true" /> Copy all new links
            </Button>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="mb-3 text-sm font-semibold text-primary">
          {message}
        </p>
      )}
      <ul className="divide-y divide-border">
        {view.players.map((p) => (
          <li key={p.playerId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="min-w-0">
              <span className="block break-words font-semibold">{p.name}</span>
              <span className="text-xs text-muted-foreground">
                {p.response.status ? STATUS[p.response.status] : "No response"}
                {p.response.overridden ? " · set by organizer" : ""}
                {" · "}
                {p.link ? (p.link.lastUsedAt ? "link used" : "link created") : "no link"}
              </span>
            </span>
            {open && (
              <span className="flex flex-wrap gap-2">
                {fresh[p.playerId] && (
                  <Button type="button" size="sm" variant="outline" onClick={() => copy(fresh[p.playerId], `Link for ${p.name} copied.`)}>
                    <Copy className="size-4" aria-hidden="true" /> Copy
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => issue([p.playerId])}>
                  <RotateCcw className="size-4" aria-hidden="true" /> {p.link ? "Regenerate" : "Create"}
                </Button>
                {p.link && (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => revoke(p.playerId)}>
                    Revoke
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
