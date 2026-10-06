"use client";

import { useState } from "react";
import { AlertTriangle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deliveryActions, type TeamsDeliveryState } from "@/lib/closeAndPostUi";

/**
 * M9.1 — "Post Teams to Telegram" in the Match Workspace, with the delivery
 * recovery the server already supports (src/lib/telegramCloseAndPost.ts,
 * telegram/delivery). The safe actions per state come from the shared
 * deliveryActions(); this component never decides on its own what may send.
 *
 *   not_posted        → Post Teams to Telegram            (intent "post")
 *   updated_available → Post Updated Teams to Telegram    (intent "post_updated")
 *   failed            → Telegram rejected it; nothing was posted → Retry posting teams (intent "post")
 *   uncertain         → Telegram MAY have it: check the chat first. Mark as sent
 *                       (records the decision, sends nothing) or Retry posting
 *                       teams after an explicit "may post twice" confirmation
 *                       (intent "retry_uncertain" + this deliveryId).
 *   sending           → a post is in progress: no action
 *   posted            → posted, no action
 * OWNER/ADMIN only: the Match Workspace renders it only for managers, and
 * every endpoint behind it answers MEMBER / foreign tenants with 404.
 */
export type TeamsPostIntent = "post" | "post_updated" | "retry_uncertain";

export default function TeamsTelegramPost({
  state,
  deliveryId,
  busy,
  onPost,
  onMarkSent,
}: {
  state: TeamsDeliveryState | null;
  deliveryId: string | null;
  busy: boolean;
  onPost: (intent: TeamsPostIntent, deliveryId?: string) => void;
  onMarkSent: (deliveryId: string) => void;
}) {
  const [confirmRetry, setConfirmRetry] = useState(false);
  const actions = deliveryActions(state ?? "not_posted");

  if (state === "posted") return <p className="text-muted-foreground">These published teams were posted to Telegram.</p>;
  if (state === "sending") return <p className="text-muted-foreground">Posting the teams to Telegram… Reload in a moment to see the result.</p>;

  if (state === "uncertain") {
    return (
      <div role="alert" className="space-y-2 rounded-tbp-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
        <p className="flex items-start gap-2 font-semibold">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>We couldn&apos;t confirm whether Telegram received the teams.</span>
        </p>
        <p className="text-xs">
          Check the Telegram group first. If the teams are there, mark them as sent — nothing will be posted. Retrying sends the message again and could post the teams twice.
        </p>
        {confirmRetry ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">Post the teams again? This can duplicate the message.</span>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRetry(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmRetry(false);
                onPost("retry_uncertain", deliveryId ?? undefined);
              }}
            >
              <Send aria-hidden="true" /> Post again
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {actions.includes("mark_sent") && (
              <Button type="button" size="sm" disabled={busy || !deliveryId} onClick={() => deliveryId && onMarkSent(deliveryId)}>
                Mark as sent
              </Button>
            )}
            {actions.includes("retry_uncertain") && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRetry(true)}>
                Retry posting teams
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div role="alert" className="space-y-2 rounded-tbp-xl border border-destructive/30 bg-destructive/5 p-3">
        <p className="flex items-start gap-2 font-semibold text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>Telegram rejected the last attempt — nothing was posted.</span>
        </p>
        {actions.includes("retry_failed") && (
          <Button type="button" size="sm" disabled={busy} onClick={() => onPost("post")}>
            <Send aria-hidden="true" /> Retry posting teams
          </Button>
        )}
      </div>
    );
  }

  const updated = state === "updated_available";
  return (
    <Button type="button" size="sm" disabled={busy} onClick={() => onPost(updated ? "post_updated" : "post")}>
      <Send aria-hidden="true" />
      {updated ? "Post Updated Teams to Telegram" : "Post Teams to Telegram"}
    </Button>
  );
}
