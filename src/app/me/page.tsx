import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionAccount, TenantContextError } from "@/lib/tenantContext";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { loadMyPlayers } from "./data";
import ConnectTelegram from "./ConnectTelegram";
import MyAttendance from "./MyAttendance";
import { formatStartTime } from "@/lib/messaging/content";
import { findSport } from "@/lib/sports";

/**
 * M6-C — "My teams": the signed-in player's claimed Player profiles.
 * Optional — taking part through Telegram never requires this page.
 */
export default async function MyTeamsPage() {
  let account;
  try {
    account = await requireSessionAccount();
  } catch (e) {
    if (e instanceof TenantContextError) redirect("/login?callbackUrl=%2Fme");
    throw e;
  }
  if (!account.emailVerified) {
    return (
      <div className="max-w-lg mx-auto rounded-2xl border bg-white shadow-sm p-5 space-y-2">
        <h1 className="text-2xl font-semibold">My teams</h1>
        <p className="text-sm text-gray-600">Verify your email address to see your teams.</p>
        <Link className="text-sm underline" href="/verify-email?next=%2Fme">Verify email</Link>
      </div>
    );
  }

  const players = await loadMyPlayers(account.id);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="rounded-2xl border bg-white shadow-sm p-5 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">My teams</h1>
        <Link className="text-sm underline" href="/account/security">Account</Link>
      </div>

      {players.length === 0 ? (
        <div className="rounded-2xl border bg-white shadow-sm p-5 text-sm text-gray-600 space-y-1">
          <p>You haven&apos;t claimed a player profile yet.</p>
          <p>Ask your organizer for a player claim link. You can still take part in polls through Telegram without one.</p>
        </div>
      ) : (
        players.map((p) => (
          <div key={p.playerId} className="rounded-2xl border bg-white shadow-sm p-5 space-y-3">
            <div>
              <div className="text-sm text-gray-500">{p.organizationName}</div>
              <div className="text-lg font-semibold">
                <Link className="underline" href={p.groupHref}>{p.groupName}</Link>{" "}
                <span className="text-xs text-gray-500 font-normal">({findSport(p.sportKey)?.label ?? p.sportKey})</span>
              </div>
              <div className="text-sm">Player: {p.displayName}</div>
            </div>
            {p.nextMatch && (
              <div className="border rounded-lg p-3 space-y-2">
                <div className="text-sm font-medium">
                  Next match: {formatLongDateOnly(p.nextMatch.date)}
                  {p.nextMatch.startTime ? ` · ${formatStartTime(p.nextMatch.startTime)}` : ""}
                  {p.nextMatch.locationName ? ` · ${p.nextMatch.locationName}` : ""}
                </div>
                <MyAttendance matchId={p.nextMatch.id} status={p.nextMatch.myStatus} byOrganizer={p.nextMatch.myStatusByOrganizer} />
                {/* M9-C — the Match page (claimed Players may view it even for LINK/PRIVATE Groups). */}
                <Link className="text-sm underline" href={`${p.groupHref}/m/${encodeURIComponent(p.nextMatch.id)}`}>View match page</Link>
                {p.nextMatch.myTeam && (
                  <div className="text-sm">
                    My team: Team #{p.nextMatch.myTeam.teamNumber} — <span className="text-gray-700">{p.nextMatch.myTeam.teammates.join(", ")}</span>
                  </div>
                )}
              </div>
            )}
            {p.recent.length === 0 ? (
              <div className="text-sm text-gray-500">No published teams with you yet.</div>
            ) : (
              <ul className="text-sm space-y-1">
                {p.recent.map((r) => (
                  <li key={r.date}>
                    <span className="font-medium">{formatLongDateOnly(r.date)}</span> — Team #{r.teamNumber}:{" "}
                    <span className="text-gray-700">{r.teammates.join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t pt-2 text-sm">
              Telegram: {p.telegramConnected ? "connected" : "not connected"}
              <ConnectTelegram playerId={p.playerId} connected={p.telegramConnected} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
