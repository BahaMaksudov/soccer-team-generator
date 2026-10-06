/**
 * M9-D — what "Post Match Summary" WILL send, as a pure function shared by
 * the organizer UI and the server (getMatchSummaryReadiness) so a future
 * agent/automation reads the same rules instead of re-implementing them.
 */
export type SummaryReadiness = { items: ReadinessItem[]; publishRecapShortcut: boolean; summaryChanged: boolean };

export type ReadinessItem = { key: "result" | "mvp" | "recap"; label: string; included: boolean; note: string | null };

/**
 * What "Post Match Summary" WILL send — published data only. Saved-but-
 * unpublished items are named explicitly so nothing is excluded silently.
 * The Publish Recap shortcut (same publish_recap action) is offered to
 * OWNER/ADMIN when a saved recap is not yet published. Nothing here
 * publishes or sends by itself.
 */
export function summaryReadiness(
  pg: {
    result: { published: boolean } | null;
    mvp: { published: boolean; closed?: boolean; method?: "PLAYER_VOTE" | "ORGANIZER_SELECTION" | null; selection?: { playerId: string } | null } | null;
    recap: { content: string | null; published: boolean; changesUnpublished?: boolean } | null;
    messages: { summary: string | null } | null;
  },
  canManage: boolean
): SummaryReadiness {
  const mvpNote = pg.mvp?.published
    ? null
    : pg.mvp?.method === "ORGANIZER_SELECTION" && pg.mvp.selection
      ? "selected, not published"
      : pg.mvp?.closed
        ? "vote closed, not published"
        : "not published";
  const recapSaved = Boolean(pg.recap?.content);
  // M9.1 — a published recap with newer saved changes: the summary uses the PUBLISHED version.
  const recapChanges = Boolean(pg.recap?.published && pg.recap.changesUnpublished);
  const recapNote = pg.recap?.published ? (recapChanges ? "published version; newer saved changes not published" : null) : recapSaved ? "saved, not published" : "not published";
  return {
    items: [
      { key: "result", label: "Final result", included: Boolean(pg.result?.published), note: pg.result?.published ? null : "not published" },
      { key: "mvp", label: "Player of the Match", included: Boolean(pg.mvp?.published), note: mvpNote },
      { key: "recap", label: "Match recap", included: Boolean(pg.recap?.published), note: recapNote },
    ],
    publishRecapShortcut: canManage && recapSaved && (!pg.recap?.published || recapChanges),
    summaryChanged: pg.messages?.summary === "updated_available",
  };
}
