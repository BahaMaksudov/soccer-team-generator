"use client";

import { useCallback, useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";

/**
 * M9.2 — Communities (rosters) of this Group: create, rename, deactivate,
 * and choose which Community each Telegram chat belongs to. Membership is
 * managed on the Players page. OWNER/ADMIN (the APIs answer 404 otherwise).
 */
type Community = { id: string; name: string; isActive: boolean; memberCount: number; telegram: Array<{ ref: number; title: string; connected: boolean }> };

export default function CommunitiesSection({ organizationSlug, groupSlug, playersHref }: { organizationSlug: string; groupSlug: string; playersHref: string }) {
  const url = (path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path });
  const [list, setList] = useState<Community[] | null>(null);
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/communities" }), { cache: "no-store" });
    if (res.ok) setList((await res.json()).communities);
  }, [organizationSlug, groupSlug]);
  useEffect(() => {
    load();
  }, [load]);

  async function send(path: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url(path), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? ok : data?.error ?? "Something went wrong.");
      await load();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  const chats = (list ?? []).flatMap((c) => c.telegram.map((t) => ({ ...t, communityId: c.id })));

  return (
    <div className="mt-4 space-y-4 rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">
        A community is one roster of this group (for example one Telegram group). Matches, attendance, teams and Player of the Match use the match&apos;s community. Add players to communities on the{" "}
        <a className="font-semibold text-primary underline" href={playersHref}>
          Players page
        </a>
        .
      </p>
      {msg && (
        <p role="status" className="text-sm text-blue-700">
          {msg}
        </p>
      )}
      {!list ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
              <input
                aria-label={`Name of ${c.name}`}
                className="h-9 min-w-0 flex-1 basis-48 rounded-md border px-2 text-sm"
                value={edit[c.id] ?? c.name}
                onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">
                {c.memberCount} player{c.memberCount === 1 ? "" : "s"}
                {c.isActive ? "" : " · inactive"}
              </span>
              {(edit[c.id] ?? c.name).trim() !== c.name && (
                <Button type="button" size="sm" disabled={busy || !(edit[c.id] ?? "").trim()} onClick={() => send(`/communities/${c.id}`, "PATCH", { name: (edit[c.id] ?? "").trim() }, "Community renamed.")}>
                  Save
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => send(`/communities/${c.id}`, "PATCH", { isActive: !c.isActive }, c.isActive ? "Community deactivated." : "Community activated.")}>
                {c.isActive ? "Deactivate" : "Activate"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send("/communities", "POST", { name: name.trim() }, "Community created.")) setName("");
        }}
      >
        <label className="min-w-0 flex-1 basis-48 text-xs font-semibold">
          New community
          <input className="mt-1 block h-9 w-full rounded-md border px-2 text-sm font-normal" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UCCNE - Indoor Soccer" maxLength={80} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          Create
        </Button>
      </form>
      {chats.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-sm font-semibold">Telegram groups</h4>
          <ul className="space-y-2">
            {chats.map((t) => (
              <li key={t.ref} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 basis-40 truncate">
                  {t.title}
                  {t.connected ? "" : " (disconnected)"}
                </span>
                <label className="text-xs">
                  <span className="sr-only">Community of {t.title}</span>
                  <select
                    className="h-9 rounded-md border px-2 text-sm"
                    value={t.communityId}
                    disabled={busy}
                    onChange={(e) => send(`/channels/telegram/${t.ref}/community`, "PUT", { communityId: e.target.value }, "Telegram group moved to the community.")}
                  >
                    {(list ?? []).filter((c) => c.isActive || c.id === t.communityId).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
