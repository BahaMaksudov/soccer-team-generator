/**
 * Why "Select Random Player" can't be used right now (null = it can) — the client-side mirror of
 * the server's rules (src/lib/spotlight.ts), used only to explain a disabled button. The server
 * always re-checks; nothing here can make a selection possible.
 */
export type SpotlightAvailabilityInput = { confirmedCount: number; poolSize: number } | null;

export function selectUnavailableReason(view: SpotlightAvailabilityInput, loadFailed: boolean): string | null {
  if (!view) return loadFailed ? "The Spotlight couldn't be loaded." : "Loading…";
  if (view.confirmedCount === 0) return "Available once players are confirmed as playing (Maybe doesn't count).";
  if (view.poolSize === 0) return "Everyone playing in this match has already had a turn this cycle — the members still waiting aren't playing.";
  return null;
}
