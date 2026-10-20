"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, UserPlus } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { emptyPlayerForm, playerFormToBody } from "@/lib/canonicalAdminState";
import { newPlayerRoleKey, type SportClientView } from "@/lib/sports";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/app/Dialog";
import { SectionCard } from "@/components/game-day/parts";
import { focusRing } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";
import CanonicalPlayerForm from "../CanonicalPlayerForm";

/**
 * M13A — "Invite players" (OWNER/ADMIN). One invite link per group: copy it and
 * share it however you like (WhatsApp, SMS, email…) — nothing is sent from
 * here. The link is shown ONCE after it's generated (only a hash is stored);
 * generating a new one turns the old one off. Each request is decided by hand:
 * link the person to an existing player without an account, or create a new
 * player for them, or reject. Joining never gives organizer access.
 */
type LinkRow = { id: string; createdAt: string; expiresAt: string; state: "active" | "expired" | "revoked"; pendingRequests: number };
type RequestRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  player: { id: string; name: string } | null;
};
type Available = { id: string; name: string; position: string; isActive: boolean };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const OUTCOME: Record<RequestRow["status"], string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", CANCELED: "Canceled by applicant" };

export default function InvitePlayersCard({ organizationSlug, groupSlug, sport }: { organizationSlug: string; groupSlug: string; sport: SportClientView }) {
  const linksApi = adminTenantApiPath({ organizationSlug, groupSlug, path: "/join-links" });
  const requestsApi = adminTenantApiPath({ organizationSlug, groupSlug, path: "/join-requests" });
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [available, setAvailable] = useState<Available[]>([]);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [creatingFor, setCreatingFor] = useState<RequestRow | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [l, r] = await Promise.all([fetch(linksApi, { cache: "no-store" }), fetch(requestsApi, { cache: "no-store" })]);
    if (l.ok) setLinks(((await l.json()) as { links: LinkRow[] }).links);
    if (r.ok) {
      const data = (await r.json()) as { requests: RequestRow[]; availablePlayers: Available[] };
      setRequests(data.requests);
      setAvailable(data.availablePlayers);
    }
  }, [linksApi, requestsApi]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setMessage({ ok: false, text: typeof data.error === "string" && data.error !== "NOT_FOUND" ? data.error : "Something went wrong." });
        return null;
      }
      return data;
    } finally {
      setBusy(false);
    }
  }
  const changed = async (text: string) => {
    setMessage({ ok: true, text });
    await load();
    // The roster on this page reloads itself (a new or newly linked player).
    window.dispatchEvent(new Event("tbp:players-changed"));
  };

  async function generate() {
    const data = await post(linksApi, { action: "create" });
    if (!data) return;
    setFreshUrl(`${window.location.origin}${String(data.path)}`);
    await changed("Invite link created. Copy it now — for security it's shown only once.");
  }
  async function revoke(id: string) {
    if (await post(linksApi, { action: "revoke", linkId: id })) {
      setFreshUrl(null);
      await changed("Invite link turned off. It no longer accepts new requests; pending requests are still listed below.");
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ ok: true, text: "Invite link copied." });
    } catch {
      setMessage({ ok: false, text: "Couldn't copy automatically — select the link and copy it." });
    }
  }
  async function approveExisting(r: RequestRow) {
    const playerId = choice[r.id];
    if (!playerId) return setMessage({ ok: false, text: "Choose the player to link first." });
    if (await post(`${requestsApi}/${encodeURIComponent(r.id)}`, { action: "approve", playerId })) await changed(`${r.firstName} ${r.lastName} approved and linked to ${available.find((a) => a.id === playerId)?.name ?? "the player"}.`);
  }
  async function reject(r: RequestRow) {
    setConfirmReject(null);
    if (await post(`${requestsApi}/${encodeURIComponent(r.id)}`, { action: "reject" })) await changed(`Request from ${r.firstName} ${r.lastName} rejected.`);
  }

  if (!links) return null;
  const active = links.find((l) => l.state === "active") ?? null;
  const pending = requests.filter((r) => r.status === "PENDING");
  const decided = requests.filter((r) => r.status !== "PENDING");

  return (
    <SectionCard
      id="invite-players"
      title="Invite players"
      icon={<UserPlus className="size-5" />}
      meta="Share one invite link with your players. Each person signs in and asks to join; you approve every request. Joining never gives organizer access."
    >
      <div className="space-y-3">
        <div className="rounded-tbp-xl border border-border p-3">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Link2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {active ? `Invite link active · expires ${day(active.expiresAt)}` : "No active invite link"}
          </p>
          {freshUrl && active && (
            <div className="mt-2 space-y-2">
              <input readOnly value={freshUrl} aria-label="Invite link" className={cn("block min-h-11 w-full rounded-tbp-md border border-input bg-muted px-3 font-mono text-xs", focusRing)} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" size="sm" variant="outline" onClick={() => copy(freshUrl)}>
                <Copy className="size-4" aria-hidden="true" /> Copy invite link
              </Button>
            </div>
          )}
          {active && !freshUrl && <p className="mt-1 text-xs text-muted-foreground">For security the link is shown only when it&apos;s created. Lost it? Generate a new one — the old one stops working.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={generate}>
              {active ? "Generate new link" : "Generate invite link"}
            </Button>
            {active && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => revoke(active.id)}>
                Turn off link
              </Button>
            )}
          </div>
        </div>

        {message && (
          <p role="status" className={cn("text-sm font-semibold", message.ok ? "text-primary" : "text-destructive")}>
            {message.text}
          </p>
        )}

        <div>
          <h3 className="text-sm font-extrabold">Join requests {pending.length > 0 && <span className="ml-1 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{pending.length}</span>}</h3>
          {pending.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No pending requests.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {pending.map((r) => (
                <li key={r.id} className="space-y-2 py-3">
                  <div className="min-w-0">
                    <p className="break-words font-semibold">
                      {r.firstName} {r.lastName}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">{r.email}</p>
                    <p className="text-xs text-muted-foreground">Requested {day(r.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`link-${r.id}`}>
                      Existing player to link
                    </label>
                    <select
                      id={`link-${r.id}`}
                      className={cn("min-h-11 min-w-0 max-w-full flex-1 rounded-tbp-md border border-input bg-card px-2 text-sm", focusRing)}
                      value={choice[r.id] ?? ""}
                      onChange={(e) => setChoice((c) => ({ ...c, [r.id]: e.target.value }))}
                    >
                      <option value="">Link to an existing player…</option>
                      {available.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.isActive ? "" : " (inactive)"}
                        </option>
                      ))}
                    </select>
                    <Button type="button" size="sm" disabled={busy || !choice[r.id]} onClick={() => approveExisting(r)}>
                      Approve &amp; link
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setCreatingFor(r)}>
                      Approve as new player
                    </Button>
                    {confirmReject === r.id ? (
                      <>
                        <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => reject(r)}>
                          Confirm reject
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReject(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReject(r.id)}>
                        Reject
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {decided.length > 0 && (
          <details className="text-sm">
            <summary className={cn("cursor-pointer font-semibold", focusRing)}>Recent decisions ({decided.length})</summary>
            <ul className="mt-2 divide-y divide-border">
              {decided.map((r) => (
                <li key={r.id} className="py-2">
                  <span className="block break-words font-semibold">
                    {r.firstName} {r.lastName}
                  </span>
                  <span className="block break-all text-xs text-muted-foreground">{r.email}</span>
                  <span className="block text-xs text-muted-foreground">
                    {OUTCOME[r.status]}
                    {r.player ? ` → ${r.player.name}` : ""}
                    {r.decidedAt ? ` · ${day(r.decidedAt)}` : ""}
                    {r.decidedBy ? ` by ${r.decidedBy}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {creatingFor && (
        <Dialog open title={`New player for ${creatingFor.firstName} ${creatingFor.lastName}`} description="Creates a player in this group and connects it to their account. Skill and stamina are used only to balance teams; players never see them." onClose={() => setCreatingFor(null)}>
          <CanonicalPlayerForm
            initial={{ ...emptyPlayerForm(newPlayerRoleKey(sport)), firstName: creatingFor.firstName, lastName: creatingFor.lastName }}
            sport={sport}
            submitLabel="Approve & create player"
            busyLabel="Approving…"
            onCancel={() => setCreatingFor(null)}
            onSubmit={async (values) => {
              const r = creatingFor;
              const res = await fetch(`${requestsApi}/${encodeURIComponent(r.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", newPlayer: playerFormToBody(values) }) });
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              if (!res.ok) return data.error && data.error !== "NOT_FOUND" ? data.error : "Could not approve the request.";
              setCreatingFor(null);
              await changed(`${r.firstName} ${r.lastName} approved as a new player.`);
              return null;
            }}
          />
        </Dialog>
      )}
    </SectionCard>
  );
}
