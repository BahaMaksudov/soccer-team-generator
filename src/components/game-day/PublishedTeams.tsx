import TeamPreview from "@/app/admin/components/TeamPreview";
import type { GeneratedTeam } from "@/app/admin/types";

/** UI-4A — read-only display of a Match's PUBLISHED teams (ids, names and role only). */
export function PublishedTeams({ teams, date, sportKey }: { teams: Array<{ teamNumber: number; players: Array<{ id: string; firstName: string; lastName: string; position: string }> }>; date: string; sportKey: string }) {
  return <TeamPreview variant="published" previewTeams={teams as unknown as GeneratedTeam[]} previewDate={date} sportKey={sportKey} />;
}
