/**
 * M6-C fix — organizer UI logic for one-time Player claim links.
 *
 * The raw claim URL exists ONLY in the API response to "create/replace"
 * and, after that, only in transient React state owned by the Players
 * section (keyed by Player id) — never in storage, the URL, or any later
 * API response. It must be handed to that section-level state BEFORE the
 * Players list is refreshed, so a refresh (which re-renders/remounts the
 * rows) can never lose it. After a real reload it is gone by design; the
 * row then shows "Claim link sent".
 */

const CLAIM_LINK_PATTERN = /^https?:\/\/[^/#?]+\/claim#[A-Za-z0-9_-]{43}$/;

/** Absolute, copyable claim URL from the create/replace response (server URL preferred). */
export function claimUrlFromResponse(data: unknown, origin: string): string | null {
  const d = (data ?? {}) as { claimUrl?: unknown; claimPath?: unknown };
  if (typeof d.claimUrl === "string" && CLAIM_LINK_PATTERN.test(d.claimUrl)) return d.claimUrl;
  if (typeof d.claimPath === "string" && /^\/claim#[A-Za-z0-9_-]{43}$/.test(d.claimPath)) {
    const url = `${origin.replace(/\/+$/, "")}${d.claimPath}`;
    return CLAIM_LINK_PATTERN.test(url) ? url : null;
  }
  return null;
}

export type AccountCellState = "claimed" | "link_ready" | "pending" | "unclaimed";

export function accountCellState(
  player: { accountClaimed?: boolean; claimPending?: boolean },
  oneTimeLink: string | null | undefined
): AccountCellState {
  if (player.accountClaimed) return "claimed";
  if (oneTimeLink) return "link_ready";
  return player.claimPending ? "pending" : "unclaimed";
}

/**
 * Create (or replace) a claim link: POST → store the returned URL in the
 * section-level state FIRST → then refresh the list. Returns the URL, or
 * an error message for the organizer.
 */
export async function createClaimLinkFlow(deps: {
  request: () => Promise<{ ok: boolean; data: unknown }>;
  origin: string;
  rememberLink: (url: string) => void;
  refresh: () => Promise<void> | void;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { ok, data } = await deps.request();
  if (!ok) {
    const error = (data as { error?: unknown } | null)?.error;
    return { ok: false, error: typeof error === "string" ? error : "Could not create a claim link." };
  }
  const url = claimUrlFromResponse(data, deps.origin);
  if (!url) return { ok: false, error: "Could not create a claim link." };
  deps.rememberLink(url);
  await deps.refresh();
  return { ok: true, url };
}
