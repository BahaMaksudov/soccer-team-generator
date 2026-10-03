"use client";

import { useEffect, useRef, useState } from "react";
import { generateRecapDraft, MATCH_TELEGRAM_GROUP_SELECTOR_ID, mvpStage, syncedRecapText } from "@/lib/postGameUi";

/**
 * M9-D — organizer post-game panel (functional only; visual design is in the
 * Lovable backlog). SAVE ≠ PUBLISH ≠ SEND: only the "Post …", "Announce …"
 * and "Start MVP vote" buttons talk to Telegram, and only OWNER/ADMIN see them.
 */

type MessageState = "not_posted" | "posted" | "updated_available" | "failed" | "uncertain" | "sending" | null;
export type PostGameView = {
  canceled: boolean;
  teamNumbers: number[];
  participants: Array<{ playerId: string; name: string; teamNumber: number }>;
  result: { scores: Array<{ teamNumber: number; score: number }>; published: boolean } | null;
  mvp: {
    started: boolean;
    open: boolean;
    closed: boolean;
    candidates: Array<{ playerId: string; name: string; votes: number }>;
    eligibleVoters: number;
    validVotes: number;
    answersNotCounted: number;
    leaders: string[];
    published: boolean;
    winners: string[];
    decision: string | null;
  } | null;
  mvpMaxCandidates: number;
  recap: { content: string | null; source: string | null; published: boolean; hasAiDraft: boolean } | null;
  standardRecap: string | null;
  aiConfigured: boolean;
  messages: { destinationConnected: boolean; result: MessageState; mvp: MessageState; recap: MessageState; mvpPoll: MessageState } | null;
};

type Act = (body: Record<string, unknown>, ok: string) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
/** Plain POST to the post-game endpoint: no view reload, no generic status message. */
type Request = (body: Record<string, unknown>) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

function PostButton({ state, label, onPost, disabled }: { state: MessageState; label: string; onPost: (intent: string) => void; disabled: boolean }) {
  if (state === "posted") return <span className="text-xs text-gray-600">Posted to Telegram.</span>;
  if (state === "sending") return <span className="text-xs text-gray-600">Posting…</span>;
  const intent = state === "updated_available" ? "post_updated" : state === "uncertain" ? "retry_uncertain" : "post";
  const text = state === "updated_available" ? `Post Updated ${label} to Telegram` : state === "uncertain" ? `Retry posting ${label} (check the group first)` : `Post ${label} to Telegram`;
  return (
    <button type="button" className="bg-sky-600 text-white rounded px-3 py-1 text-sm disabled:opacity-60" disabled={disabled} onClick={() => onPost(intent)}>
      {text} <span className="text-xs">(sends a message)</span>
    </button>
  );
}

export default function PostGameSection({
  pg,
  canManage,
  busy,
  act,
  request,
  notify,
}: {
  pg: PostGameView;
  canManage: boolean;
  busy: boolean;
  act: Act;
  request: Request;
  notify: (message: string | null) => void;
}) {
  const [scores, setScores] = useState<Record<number, string>>({});
  const [recapText, setRecapText] = useState<string>(pg.recap?.content ?? "");
  const [shortlist, setShortlist] = useState<string[]>([]);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const savedKey = JSON.stringify(pg.result?.scores ?? []);
  useEffect(() => {
    setScores(Object.fromEntries((pg.result?.scores ?? []).map((s) => [s.teamNumber, String(s.score)])));
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only a newly SAVED server recap replaces the textarea; an empty server value never clears an unsaved draft.
  const lastServerRecap = useRef<string | null | undefined>(pg.recap?.content);
  useEffect(() => {
    const next = pg.recap?.content;
    setRecapText((current) => syncedRecapText(current, lastServerRecap.current, next));
    lastServerRecap.current = next;
  }, [pg.recap?.content]);

  if (pg.canceled) return <div className="text-sm text-gray-600">This match is canceled — reopen it to record a result, MVP or recap.</div>;
  if (pg.teamNumbers.length === 0) return <div className="text-sm text-gray-600">Publish teams for this match to record a result.</div>;

  const m = pg.messages;
  const tg = canManage && m;
  const needsShortlist = pg.participants.length > pg.mvpMaxCandidates && !pg.mvp?.started;
  const stage = mvpStage(pg, canManage);
  const post = (kind: "result" | "mvp" | "recap") => (intent: string) => act({ action: "post_message", kind, intent }, "Posted to Telegram.");

  return (
    <div className="space-y-4">
      {tg && !m.destinationConnected && <div className="text-xs text-amber-700">Choose a connected Telegram group for this match (Attendance section) to post to Telegram.</div>}

      {/* Result */}
      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Result {pg.result?.published ? <span className="text-xs text-emerald-700">· published</span> : pg.result ? <span className="text-xs text-gray-500">· saved, not published</span> : null}</div>
        <div className="flex flex-wrap gap-3">
          {pg.teamNumbers.map((n) => (
            <label key={n} className="flex items-center gap-1">
              Team {n}
              <input type="number" min={0} max={999} className="border rounded px-2 py-1 w-20" value={scores[n] ?? ""} onChange={(e) => setScores({ ...scores, [n]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="border rounded px-3 py-1"
            disabled={busy || pg.teamNumbers.some((n) => scores[n] === undefined || scores[n] === "")}
            onClick={() => act({ action: "save_result", scores: pg.teamNumbers.map((n) => ({ teamNumber: n, score: Number(scores[n]) })) }, pg.result?.published ? "Result corrected. Telegram was not updated." : "Result saved (not published).")}
          >
            Save Result
          </button>
          {pg.result && !pg.result.published && (
            <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_result" }, "Result published on the match page. Nothing was sent.")}>
              Publish Result
            </button>
          )}
          {tg && pg.result?.published && m.destinationConnected && <PostButton state={m.result} label="Result" disabled={busy} onPost={post("result")} />}
        </div>
      </div>

      {/* MVP — explicit stages (decided by vote among published participants; no free-text MVP) */}
      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Player of the Match {pg.mvp?.published ? <span className="text-xs text-emerald-700">· published</span> : null}</div>
        {stage === "RESULT_NOT_PUBLISHED" && <div className="text-xs text-gray-600">Publish the result before starting Player of the Match voting.</div>}
        {stage === "NEEDS_TELEGRAM_GROUP" && (
          <div className="text-xs text-gray-700 space-y-1">
            <div>Player of the Match is chosen by a vote of this match&apos;s players in Telegram. Select a connected Telegram group for this match to start Player of the Match voting.</div>
            <button
              type="button"
              className="underline"
              onClick={() => document.getElementById(MATCH_TELEGRAM_GROUP_SELECTOR_ID)?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              Choose Telegram group
            </button>
          </div>
        )}
        {stage === "WAITING_FOR_MANAGER" && <div className="text-xs text-gray-600">An owner or admin starts the Player of the Match vote in the match&apos;s Telegram group.</div>}
        {stage === "READY_TO_START" && m && (
          <div className="space-y-2">
            <div className="text-xs text-gray-600">Posts a Player of the Match poll to the match&apos;s Telegram group. Only players of the published teams can vote, and not for themselves.</div>
            {needsShortlist && (
              <div className="text-xs space-y-1">
                <div>Telegram polls list at most {pg.mvpMaxCandidates} players. Choose the shortlist ({shortlist.length}/{pg.mvpMaxCandidates}):</div>
                <div className="flex flex-wrap gap-2">
                  {pg.participants.map((p) => (
                    <label key={p.playerId} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={shortlist.includes(p.playerId)}
                        onChange={() => setShortlist((s) => (s.includes(p.playerId) ? s.filter((x) => x !== p.playerId) : s.length < pg.mvpMaxCandidates ? [...s, p.playerId] : s))}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className="bg-sky-600 text-white rounded px-3 py-1 disabled:opacity-60"
              disabled={busy || (needsShortlist && shortlist.length < 2)}
              onClick={() => act({ action: "start_mvp", ...(needsShortlist ? { candidateIds: shortlist } : {}), ...(m.mvpPoll === "uncertain" ? { intent: "retry_uncertain" } : {}) }, "Player of the Match poll posted to Telegram.")}
            >
              {m.mvpPoll === "uncertain" ? "Retry Player of the Match poll (check the group first)" : "Start Player of the Match Vote"} <span className="text-xs">(sends a poll)</span>
            </button>
          </div>
        )}
        {(stage === "OPEN" || stage === "CLOSED" || stage === "PUBLISHED") && pg.mvp && (
          <div className="space-y-1">
            <div className="text-xs text-gray-600">
              {pg.mvp.open ? "Voting open" : "Voting closed"} · {pg.mvp.validVotes} valid vote(s) of {pg.mvp.eligibleVoters} players
              {pg.mvp.answersNotCounted > 0 ? ` · ${pg.mvp.answersNotCounted} answer(s) not counted (unlinked, not a participant or self-vote)` : ""}
            </div>
            <ul className="text-xs">
              {pg.mvp.candidates.map((c) => (
                <li key={c.playerId}>{c.name} — {c.votes}</li>
              ))}
            </ul>
          </div>
        )}
        {stage === "OPEN" && (canManage ? (
          <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "close_mvp" }, "Vote closed. Nothing was announced.")}>
            Close Vote
          </button>
        ) : (
          <div className="text-xs text-gray-600">An owner or admin closes the vote.</div>
        ))}
        {(stage === "CLOSED" || stage === "PUBLISHED") && pg.mvp && (
          <div className="flex flex-wrap gap-2 items-center">
            {pg.mvp.leaders.length === 1 && (
              <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_mvp" }, "Player of the Match published on the match page. Nothing was sent.")}>
                {pg.mvp.published ? "Republish" : "Publish Player of the Match"}
              </button>
            )}
            {pg.mvp.leaders.length > 1 && (
              <>
                <span className="text-xs text-amber-700">Tied: {pg.mvp.candidates.filter((c) => pg.mvp!.leaders.includes(c.playerId)).map((c) => c.name).join(", ")}</span>
                <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_mvp", tieBreak: { mode: "co" } }, "Co-Players of the Match published. Nothing was sent.")}>
                  Publish co-Players of the Match
                </button>
                {pg.mvp.leaders.map((id) => (
                  <button key={id} type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_mvp", tieBreak: { mode: "pick", playerId: id } }, "Player of the Match published (organizer tie-break). Nothing was sent.")}>
                    Pick {pg.mvp!.candidates.find((c) => c.playerId === id)?.name}
                  </button>
                ))}
              </>
            )}
            {pg.mvp.leaders.length === 0 && <span className="text-xs text-gray-500">The vote closed with no valid votes, so there is no Player of the Match to publish.</span>}
          </div>
        )}
        {stage === "PUBLISHED" && pg.mvp && (
          <div className="space-y-1">
            <div className="text-xs">
              Published: {pg.mvp.winners.join(", ")}
              {pg.mvp.decision === "ORGANIZER_TIEBREAK" ? " (organizer tie-break)" : ""}
            </div>
            {tg && m.destinationConnected && <PostButton state={m.mvp} label="Player of the Match" disabled={busy} onPost={post("mvp")} />}
            {tg && !m.destinationConnected && <div className="text-xs text-gray-600">Select a connected Telegram group for this match to announce it.</div>}
          </div>
        )}
      </div>

      {/* Recap */}
      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">
          Match Recap {pg.recap?.published ? <span className="text-xs text-emerald-700">· published</span> : pg.recap?.content ? <span className="text-xs text-gray-500">· saved, not published</span> : null}
        </div>
        {!pg.standardRecap ? (
          <div className="text-xs text-gray-500">Publish the result before writing the recap.</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="border rounded px-3 py-1"
                disabled={busy || generating || !pg.aiConfigured}
                title={pg.aiConfigured ? undefined : "AI is not configured"}
                onClick={async () => {
                  setGenerating(true);
                  try {
                    // Review only: no reload, nothing saved as the recap, nothing published or sent.
                    await generateRecapDraft({ request, setDraft: setRecapText, notify, setError: setAiMessage });
                  } finally {
                    setGenerating(false);
                  }
                }}
              >
                {generating ? "Generating…" : "Generate AI Recap"}
              </button>
              <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => setRecapText(pg.standardRecap ?? "")}>
                Use standard recap
              </button>
            </div>
            {!pg.aiConfigured && <div className="text-xs text-gray-500">AI recaps are not set up; the standard recap is always available.</div>}
            {aiMessage && <div className="text-xs text-amber-700">{aiMessage}</div>}
            <textarea className="border rounded w-full p-2 text-sm" rows={4} maxLength={1200} value={recapText} onChange={(e) => setRecapText(e.target.value)} placeholder="Recap text" />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="border rounded px-3 py-1" disabled={busy || !recapText.trim()} onClick={() => act({ action: "save_recap", content: recapText }, pg.recap?.published ? "Recap updated. Telegram was not updated." : "Recap saved (not published).")}>
                Save Recap
              </button>
              {pg.recap?.content && !pg.recap.published && (
                <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_recap" }, "Recap published on the match page. Nothing was sent.")}>
                  Publish Recap
                </button>
              )}
              {tg && pg.recap?.published && m.destinationConnected && <PostButton state={m.recap} label="Recap" disabled={busy} onPost={post("recap")} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
