"use client";

import { useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";

/**
 * M6-A — who can see this Group's player-facing pages, plus the share
 * link. Owners/admins only (the API answers 404 for other roles, and
 * this section then hides itself). The raw link is shown once, right
 * after it is created.
 */
type Visibility = "PUBLIC" | "LINK" | "PRIVATE";

const OPTIONS: Array<{ value: Visibility; label: string; help: string }> = [
  { value: "PUBLIC", label: "Public", help: "Anyone with the Group URL can view." },
  { value: "LINK", label: "Link", help: "Only people with the share link can view; no account required." },
  { value: "PRIVATE", label: "Private", help: "Only authorized Team Balance Pro users can view." },
];

export default function CanonicalVisibilitySection({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const settingsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/settings/visibility" });
  const linkUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/share-link" });
  const publicPath = `/g/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(groupSlug)}`;

  const [allowed, setAllowed] = useState(true);
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [activeLinkAt, setActiveLinkAt] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch(settingsUrl, { cache: "no-store" });
    if (!res.ok) {
      setAllowed(false);
      return;
    }
    const data = await res.json();
    setVisibility(data.visibility);
    setActiveLinkAt(data.activeLink?.createdAt ?? null);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsUrl]);

  async function save(next: Visibility) {
    setBusy(true);
    setMsg(null);
    const res = await fetch(settingsUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: next }),
    });
    setBusy(false);
    if (!res.ok) return setMsg("Could not save visibility.");
    const data = await res.json();
    setVisibility(data.visibility);
    setMsg("Saved.");
  }

  async function createLink() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(linkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setBusy(false);
    if (!res.ok) return setMsg("Could not create a share link.");
    const data = await res.json();
    setNewLink(`${window.location.origin}${data.sharePath}`);
    setActiveLinkAt(data.createdAt);
  }

  async function revoke() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(linkUrl, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setMsg("Could not revoke the share link.");
    setNewLink(null);
    setActiveLinkAt(null);
    setMsg("Share link revoked. The old link no longer works.");
  }

  async function copy() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink);
      setMsg("Link copied.");
    } catch {
      setMsg("Copy failed — select the link and copy it manually.");
    }
  }

  if (!allowed || visibility === null) return null;

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Who can view this group</div>
      <div className="space-y-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="visibility" className="mt-1" checked={visibility === o.value} disabled={busy}
              onChange={() => save(o.value)} />
            <span>
              <span className="font-medium">{o.label}</span> — {o.help}
            </span>
          </label>
        ))}
      </div>
      {visibility === "PUBLIC" && (
        <div className="text-sm text-gray-600">
          Public page: <a className="underline" href={publicPath}>{publicPath}</a>
        </div>
      )}

      {visibility === "LINK" && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-sm font-medium">Share link</div>
          <div className="text-sm text-gray-600">
            {activeLinkAt
              ? `A share link is active (created ${new Date(activeLinkAt).toLocaleString()}). For security it is shown only once; create a new one to get a copyable link — the old one stops working.`
              : "No active share link."}
          </div>
          {newLink && (
            <div className="space-y-1">
              <code className="block text-xs break-all bg-gray-50 border rounded p-2">{newLink}</code>
              <button type="button" className="text-sm border rounded-md px-3 py-1.5" onClick={copy}>Copy link</button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="text-sm bg-black text-white rounded-md px-3 py-1.5 disabled:opacity-60" disabled={busy} onClick={createLink}>
              {activeLinkAt ? "Create new link (replaces current)" : "Create share link"}
            </button>
            {activeLinkAt && (
              <button type="button" className="text-sm border rounded-md px-3 py-1.5 disabled:opacity-60" disabled={busy} onClick={revoke}>
                Revoke link
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <div className="text-sm text-gray-700">{msg}</div>}
    </div>
  );
}
