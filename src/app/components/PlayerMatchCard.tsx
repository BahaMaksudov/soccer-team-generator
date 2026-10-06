import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { PlayerMatchView } from "@/lib/matchPage";

/**
 * M9-C — player-facing Match content (functional only; visual design is in
 * the Lovable backlog). Renders the allow-listed PlayerMatchView only.
 */
export default function PlayerMatchCard({ view, signInHref }: { view: PlayerMatchView; signInHref?: string | null }) {
  const { group, match } = view;
  const time = formatStartTime(match.startTime);
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-1">
        <h1 className="text-2xl font-semibold">{group.teamName || group.name}</h1>
        <div className="text-sm text-gray-600">
          {[group.teamName && group.teamName !== group.name ? group.name : null, group.organizationName, group.sportLabel].filter(Boolean).join(" · ")}
        </div>
        <div className="font-medium">
          {formatLongDateOnly(match.date)}
          {time ? ` · ${time}` : ""}
        </div>
        {match.locationName && <div className="text-sm text-gray-700">{match.locationName}</div>}
        {match.status === "CANCELED" && <div className="text-sm font-medium text-rose-700">This match was canceled.</div>}
        {match.status === "COMPLETED" && <div className="text-sm text-gray-600">This match is completed.</div>}
      </div>

      {/* M9-D — only PUBLISHED post-game data is in the view. */}
      {view.result && (
        <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-1">
          <div className="font-semibold">Final Result</div>
          {/* M8.1 — one row per fixture (every pair of teams once), each with its own winner or draw. */}
          {view.result.legacyStandings ? (
            <>
              {view.result.legacyStandings.map((t) => (
                <div key={t.teamNumber} className="flex justify-between max-w-xs">
                  <span>Team {t.teamNumber}</span>
                  <span className="font-semibold">{t.score}</span>
                </div>
              ))}
              <div className="text-xs text-gray-500">Recorded as one score per team.</div>
            </>
          ) : (
            <ul className="space-y-1">
              {view.result.fixtures.map((f) => (
                <li key={`${f.teamA}-${f.teamB}`} className="flex flex-wrap items-baseline justify-between gap-x-4 max-w-sm">
                  <span>
                    Team {f.teamA} <span className="font-semibold tabular-nums">{f.scoreA} – {f.scoreB}</span> Team {f.teamB}
                  </span>
                  <span className="text-sm text-gray-600">{f.winner === null ? "Draw" : `Team ${f.winner} won`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!view.teamsPublished ? (
        <div className="rounded-2xl border bg-white shadow-sm p-5 text-gray-600">Teams have not been published yet.</div>
      ) : (
        <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {view.teams.map((t) => (
                <tr key={t.teamNumber} className="border-t first:border-t-0">
                  <td className="p-3 font-semibold align-top w-24">Team #{t.teamNumber}</td>
                  <td className="p-3">
                    <ul className="space-y-1">
                      {t.players.map((p, i) => (
                        <li key={i}>
                          {p.name}
                          {p.role && <span className="text-gray-500"> — {p.role}</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.mvp && (
        <div className="rounded-2xl border bg-white shadow-sm p-5">
          <div className="font-semibold">{view.mvp.shared ? "Players of the Match" : "Player of the Match"}</div>
          <div>🏆 {view.mvp.names.join(", ")}</div>
        </div>
      )}

      {view.recap && (
        <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-1">
          <div className="font-semibold">Match Recap</div>
          <p className="whitespace-pre-line text-gray-800">{view.recap.text}</p>
        </div>
      )}

      {signInHref && (
        <div className="text-xs text-gray-500">
          Have a Team Balance Pro account? <a className="underline" href={signInHref}>Sign in</a> to see your matches.
        </div>
      )}
    </div>
  );
}
