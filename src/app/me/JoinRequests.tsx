"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MyJoinRequest } from "@/lib/groupJoin";

/**
 * M13A — the user's own group join requests on /me: pending ones (cancelable)
 * and recent outcomes. Neutral wording; no organizer data.
 */
const STATUS: Record<MyJoinRequest["status"], string> = {
  PENDING: "Waiting for organizer approval",
  APPROVED: "Approved — the group's games appear below",
  REJECTED: "Not approved — contact the organizer if you think this is a mistake",
  CANCELED: "Canceled",
};

export default function JoinRequests({ requests }: { requests: MyJoinRequest[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function cancel(id: string) {
    setBusy(id);
    try {
      await fetch("/api/join/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: id }) });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  if (requests.length === 0) return null;
  return (
    <section aria-labelledby="join-requests-h" className="rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5">
      <h2 id="join-requests-h" className="text-lg font-extrabold">
        Group requests
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="min-w-0">
              <span className="block break-words font-semibold">{r.groupName}</span>
              <span className="block break-words text-xs text-muted-foreground">
                {r.organizationName} · {STATUS[r.status]}
              </span>
            </span>
            {r.status === "PENDING" && (
              <button
                type="button"
                disabled={busy === r.id}
                onClick={() => cancel(r.id)}
                className="min-h-11 rounded-full border border-input px-4 text-sm font-semibold hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Cancel request
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
