/**
 * M9-A — published teams vs working preview.
 *
 * A team ASSIGNMENT is "which players are on which team number". Two
 * assignments are the same when every team number has the same set of
 * player ids — player order inside a team and team order in the array do
 * not matter; a player moving to another team, or a membership change, does.
 */

type TeamLike = { teamNumber: number; players: Array<{ id: string }> };

/** Deterministic canonical key: teams by number, player ids sorted. */
export function assignmentKey(teams: readonly TeamLike[]): string {
  return JSON.stringify(
    [...teams]
      .sort((a, b) => a.teamNumber - b.teamNumber)
      .map((t) => [t.teamNumber, t.players.map((p) => p.id).sort()])
  );
}

export function sameAssignment(a: readonly TeamLike[] | null | undefined, b: readonly TeamLike[] | null | undefined): boolean {
  if (!a || !b) return false;
  return assignmentKey(a) === assignmentKey(b);
}

/**
 * What the Teams panel shows (pure, so it is testable without React):
 *  none                         nothing generated or published → "Generate"
 *  preview                      unpublished preview, nothing published
 *  published                    published teams; no different preview
 *  published_with_new_preview   published teams (what players see) + a different, unpublished preview
 * Generate becomes "Regenerate" once anything exists; Publish is only
 * offered for a preview that differs from the published teams.
 */
export type TeamsPanelMode = "none" | "preview" | "published" | "published_with_new_preview";

export function teamsPanelState(preview: readonly TeamLike[] | null, published: readonly TeamLike[] | null) {
  const mode: TeamsPanelMode = !preview
    ? published
      ? "published"
      : "none"
    : !published
      ? "preview"
      : sameAssignment(preview, published)
        ? "published"
        : "published_with_new_preview";
  return {
    mode,
    generateLabel: mode === "none" ? "Generate" : "Regenerate",
    canPublish: mode === "preview" || mode === "published_with_new_preview",
    canClearPreview: preview !== null,
    /** Only ONE full team table is shown: the preview when one exists, else the published teams. */
    showPublishedTable: preview === null && published !== null,
    /** "Published" only when the displayed teams ARE the published ones; never implies an unpublished preview is published. */
    badge: mode === "published" ? "Published" : mode === "published_with_new_preview" ? "Published version exists" : null,
    /** Compact note instead of a second (old) table while a different preview is being evaluated. */
    publishedVersionNote: mode === "published_with_new_preview",
    /**
     * Telegram team posting is offered only when nothing unpublished is on screen.
     * The post itself always uses the canonical published TeamGeneration (by id,
     * server-side) — never the preview.
     */
    canPostPublishedTeams: published !== null && !unpublishedPreviewOnScreen(mode),
  };
}

export type TeamsPanelState = ReturnType<typeof teamsPanelState>;

/**
 * True while an unpublished preview (one that differs from the published
 * teams) is on screen: Telegram team posting is hidden then, so a preview can
 * never look like what will be sent.
 */
export function unpublishedPreviewOnScreen(mode: TeamsPanelMode): boolean {
  return mode === "preview" || mode === "published_with_new_preview";
}
