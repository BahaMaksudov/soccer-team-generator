/**
 * M9-B — which Group Players the Match workspace lists by default.
 *
 * With a Telegram chat selected, the list defaults to that chat's player
 * scope — but it is a PRESENTATION default, never an eligibility rule:
 *  - a Player with any Match state (an attendance answer or override, a
 *    selection for teams, or a place in the published teams) is always listed,
 *    so changing the chat never hides an existing participant;
 *  - the organizer can add any other Group Player ("Add another player");
 *  - "Show all Group players" lists everyone.
 * Without a selected chat, every active Player is listed (unchanged).
 * Order follows the roster order given.
 */
export function visibleRosterIds(input: {
  rosterIds: readonly string[];
  chatSelected: boolean;
  scopeIds: readonly string[];
  withMatchState: ReadonlySet<string>;
  addedIds: readonly string[];
  showAll: boolean;
}): string[] {
  if (!input.chatSelected || input.showAll) return [...input.rosterIds];
  const scope = new Set(input.scopeIds);
  const added = new Set(input.addedIds);
  return input.rosterIds.filter((id) => scope.has(id) || input.withMatchState.has(id) || added.has(id));
}
