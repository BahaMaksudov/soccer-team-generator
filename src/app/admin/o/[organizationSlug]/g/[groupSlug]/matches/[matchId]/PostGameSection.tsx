"use client";

import { useEffect, useRef, useState } from "react";
import {
  aiButtonLabel,
  generateRecapDraft,
  MATCH_TELEGRAM_GROUP_SELECTOR_ID,
  mvpMethodSwitchable,
  mvpStage,
  needsReplaceConfirmation,
  resultEditorState,
  summaryReadiness,
  syncedRecapText,
  type MvpMethod,
} from "@/lib/postGameUi";

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
    method: MvpMethod | null;
    voteLocked: boolean;
    selection: { playerId: string; name: string; teamNumber: number | null } | null;
  } | null;
  mvpMaxCandidates: number;
  recap: { content: string | null; source: string | null; published: boolean; hasAiDraft: boolean } | null;
  standardRecap: string | null;
  aiConfigured: boolean;
  // M9-D — Match Summary is the only post-game Telegram message (plus the Player Vote poll).
  messages: { destinationConnected: boolean; summary: MessageState; mvpPoll: MessageState } | null;
};

type Act = (body: Record<string, unknown>, ok: string) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
/** Plain POST to the post-game endpoint: no view reload, no generic status message. */
type Request = (body: Record<string, unknown>) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

function PostButton({ state, label, onPost, disabled, primary }: { state: MessageState; label: string; onPost: (intent: string) => void; disabled: boolean; primary?: boolean }) {
  if (state === "posted") return <span className="text-xs text-gray-600">{primary ? `${label} posted to Telegram.` : "Posted to Telegram."}</span>;
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
  // Player of the Match: the organizer's in-page method choice (until the server locks one) and pick.
  const [chosenMethod, setChosenMethod] = useState<MvpMethod | null>(null);
  const [selectPick, setSelectPick] = useState("");
  // Recap editing session: AI draft generated? last value WE put in the textarea; pending replacement.
  const [aiGenerated, setAiGenerated] = useState(false);
  const [lastProgrammatic, setLastProgrammatic] = useState<string | null>(pg.recap?.content ?? null);
  const [pendingReplace, setPendingReplace] = useState<"ai" | "standard" | null>(null);
  const savedKey = JSON.stringify(pg.result?.scores ?? []);
  useEffect(() => {
    setScores(Object.fromEntries((pg.result?.scores ?? []).map((s) => [s.teamNumber, String(s.score)])));
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only a newly SAVED server recap replaces the textarea; an empty server value never clears an unsaved draft.
  const lastServerRecap = useRef<string | null | undefined>(pg.recap?.content);
  useEffect(() => {
    const next = pg.recap?.content;
    if (typeof next === "string" && next.length > 0 && next !== lastServerRecap.current) setLastProgrammatic(next);
    setRecapText((current) => syncedRecapText(current, lastServerRecap.current, next));
    lastServerRecap.current = next;
  }, [pg.recap?.content]);

  if (pg.canceled) return <div className="text-sm text-gray-600">This match is canceled — reopen it to record a result, MVP or recap.</div>;
  if (pg.teamNumbers.length === 0) return <div className="text-sm text-gray-600">Publish teams for this match to record a result.</div>;

  const m = pg.messages;
  const tg = canManage && m;
  const needsShortlist = pg.participants.length > pg.mvpMaxCandidates && !pg.mvp?.started;
  const stage = mvpStage(pg, canManage, chosenMethod);
  const readiness = summaryReadiness(pg, canManage);
  const switchable = canManage && mvpMethodSwitchable(pg);

  // Recap: replacing the textarea asks first only when it holds the organizer's own unsaved edits.
  const runGenerate = async () => {
    setGenerating(true);
    try {
      // Review only: no reload, nothing saved as the recap, nothing published or sent.
      const r = await generateRecapDraft({
        request,
        setDraft: (t) => {
          setRecapText(t);
          setLastProgrammatic(t);
        },
        notify,
        setError: setAiMessage,
        regenerate: aiGenerated,
      });
      if (r === "draft") setAiGenerated(true);
    } finally {
      setGenerating(false);
    }
  };
  const applyStandardRecap = () => {
    const t = pg.standardRecap ?? "";
    setRecapText(t);
    setLastProgrammatic(t);
  };
  const requestReplace = (kind: "ai" | "standard") => {
    if (needsReplaceConfirmation(recapText, lastProgrammatic, pg.recap?.content)) setPendingReplace(kind);
    else if (kind === "ai") void runGenerate();
    else applyStandardRecap();
  };
  const postSummary = (intent: string) => act({ action: "post_message", kind: "summary", intent }, "Match summary posted to Telegram.");
  const editor = resultEditorState(pg.teamNumbers, pg.result?.scores ?? null, scores);

  return (
    <div className="space-y-4">

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
        <div className="flex flex-wrap gap-2 items-center">
          {editor.action ? (
            <button
              type="button"
              className="border rounded px-3 py-1 disabled:opacity-60"
              disabled={busy || !editor.valid}
              onClick={() =>
                act(
                  { action: "save_result", scores: pg.teamNumbers.map((n) => ({ teamNumber: n, score: Number(scores[n]) })) },
                  pg.result?.published ? "Result changes saved. Telegram was not updated." : "Result saved (not published)."
                )
              }
            >
              {editor.action === "SAVE_CHANGES" ? "Save Changes" : "Save Result"}
            </button>
          ) : (
            <span className="text-xs text-gray-600">Saved.</span>
          )}
          {editor.action === "SAVE_CHANGES" && <span className="text-xs text-amber-700">Unsaved changes</span>}
          {pg.result && !pg.result.published && !editor.dirty && (
            <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_result" }, "Result published on the match page. Nothing was sent.")}>
              Publish Result
            </button>
          )}
        </div>
      </div>

      {/* Player of the Match — Player Vote (Telegram poll) or Organizer Selection; always a published participant, never free text */}
      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Player of the Match {pg.mvp?.published ? <span className="text-xs text-emerald-700">· published</span> : null}</div>
        {stage === "RESULT_NOT_PUBLISHED" && <div className="text-xs text-gray-600">Publish the result before choosing Player of the Match.</div>}
        {stage === "WAITING_FOR_MANAGER" && <div className="text-xs text-gray-600">An owner or admin decides Player of the Match for this match.</div>}

        {switchable && (
          <div className="space-y-1">
            <div className="text-xs text-gray-700">Choose how Player of the Match will be decided:</div>
            <div className="flex flex-wrap gap-2">
              {(["PLAYER_VOTE", "ORGANIZER_SELECTION"] as const).map((mth) => (
                <button
                  key={mth}
                  type="button"
                  className={`border rounded px-3 py-1 ${chosenMethod === mth ? "bg-gray-900 text-white" : ""}`}
                  onClick={() => setChosenMethod(mth)}
                >
                  {mth === "PLAYER_VOTE" ? "Player Vote" : "Organizer Selection"}
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "NEEDS_TELEGRAM_GROUP" && (
          <div className="text-xs text-gray-700 space-y-1">
            <div>Player Vote runs as a Telegram poll among this match&apos;s players. Select a connected Telegram group for this match to start Player of the Match voting{switchable ? " — or use Organizer Selection, which needs no Telegram group." : "."}</div>
            <button type="button" className="underline" onClick={() => document.getElementById(MATCH_TELEGRAM_GROUP_SELECTOR_ID)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              Choose Telegram group
            </button>
          </div>
        )}
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
        {(stage === "OPEN" || stage === "CLOSED" || (stage === "PUBLISHED" && pg.mvp?.method !== "ORGANIZER_SELECTION")) && pg.mvp?.started && (
          <div className="space-y-1">
            <div className="text-xs text-gray-600">
              Player Vote · {pg.mvp.open ? "voting open" : "voting closed"} · {pg.mvp.validVotes} valid vote(s) of {pg.mvp.eligibleVoters} players
              {pg.mvp.answersNotCounted > 0 ? ` · ${pg.mvp.answersNotCounted} answer(s) not counted (unlinked, not a participant or self-vote)` : ""}
            </div>
            <ul className="text-xs">
              {pg.mvp.candidates.map((c) => (
                <li key={c.playerId}>{c.name} — {c.votes}</li>
              ))}
            </ul>
          </div>
        )}
        {stage === "OPEN" && (
          <>
            <div className="text-xs text-gray-500">The method is locked to Player Vote while voting is open.</div>
            <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "close_mvp" }, "Vote closed. Nothing was announced.")}>
              Close Vote
            </button>
          </>
        )}
        {(stage === "CLOSED" || (stage === "PUBLISHED" && pg.mvp?.method !== "ORGANIZER_SELECTION")) && pg.mvp && (
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

        {stage === "SELECT_PLAYER" && (
          <div className="space-y-2">
            <div className="text-xs text-gray-700">Select Player of the Match (players of this match&apos;s published teams). No Telegram group is needed.</div>
            <select className="border rounded px-2 py-1" value={selectPick} onChange={(e) => setSelectPick(e.target.value)}>
              <option value="">Select a player…</option>
              {pg.participants.map((p) => (
                <option key={p.playerId} value={p.playerId}>{p.name} — Team {p.teamNumber}</option>
              ))}
            </select>
            <div>
              <button type="button" className="border rounded px-3 py-1" disabled={busy || !selectPick} onClick={() => act({ action: "save_mvp_selection", playerId: selectPick }, "Player of the Match selection saved — not published.")}>
                Save Selection
              </button>
            </div>
          </div>
        )}
        {stage === "SELECTION_SAVED" && pg.mvp?.selection && (
          <div className="space-y-2">
            <div className="text-xs text-gray-700">
              Organizer Selection: <b>{pg.mvp.selection.name}</b>{pg.mvp.selection.teamNumber ? ` — Team ${pg.mvp.selection.teamNumber}` : ""} · saved, not published.
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_mvp" }, "Player of the Match published on the match page. Nothing was sent.")}>
                Publish Player of the Match
              </button>
              <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "reset_mvp_selection" }, "Selection reset. Choose how Player of the Match will be decided.")}>
                Change / reset selection
              </button>
            </div>
          </div>
        )}

        {stage === "PUBLISHED" && pg.mvp && (
          <div className="space-y-1">
            <div className="text-xs">
              Published: {pg.mvp.winners.join(", ")}
              {pg.mvp.method === "ORGANIZER_SELECTION" ? " (organizer selection)" : pg.mvp.decision === "ORGANIZER_TIEBREAK" ? " (organizer tie-break)" : ""}
            </div>
            <div className="text-xs text-gray-500">It is sent to Telegram with the Match Summary below.</div>
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
                disabled={busy || generating || !pg.aiConfigured || pendingReplace !== null}
                title={pg.aiConfigured ? undefined : "AI is not configured"}
                onClick={() => requestReplace("ai")}
              >
                {generating ? "Generating…" : aiButtonLabel(aiGenerated)}
              </button>
              <button type="button" className="border rounded px-3 py-1" disabled={busy || generating || pendingReplace !== null} onClick={() => requestReplace("standard")}>
                Use standard recap
              </button>
            </div>
            {pendingReplace && (
              <div className="text-xs border rounded p-2 bg-amber-50 space-y-1">
                <div>{pendingReplace === "ai" ? "Regenerating" : "Using the standard recap"} will replace your current unsaved recap. Continue?</div>
                <div className="flex gap-2">
                  <button type="button" className="border rounded px-2 py-0.5" onClick={() => setPendingReplace(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="border rounded px-2 py-0.5 bg-white"
                    onClick={() => {
                      const kind = pendingReplace;
                      setPendingReplace(null);
                      if (kind === "ai") void runGenerate();
                      else applyStandardRecap();
                    }}
                  >
                    {pendingReplace === "ai" ? (aiGenerated ? "Regenerate" : "Generate") : "Replace"}
                  </button>
                </div>
              </div>
            )}
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
            </div>
          </>
        )}
      </div>

      {/* Match Summary — the preferred single post (published data only; sending is separate from publishing) */}
      <div className="border-2 border-sky-200 rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Match Summary</div>
        <div className="text-xs text-gray-600">Send the published result, Player of the Match and recap together in one Telegram message.</div>
        {!pg.result?.published ? (
          <div className="text-xs text-gray-600">Publish the result before posting the match summary.</div>
        ) : (
          <>
            <div className="text-xs space-y-0.5">
              <div className="text-gray-700">Ready to send:</div>
              {readiness.items.map((it) => (
                <div key={it.key} className={it.included ? "text-emerald-700" : "text-gray-500"}>
                  {it.included ? "✓" : "○"} {it.label}
                  {it.note ? ` — ${it.note}` : ""}
                </div>
              ))}
            </div>
            {readiness.publishRecapShortcut && (
              <div className="text-xs space-y-1 border rounded p-2 bg-amber-50">
                <div>Match recap is saved but not published. Publish it to include it in the Match Summary.</div>
                <button type="button" className="bg-emerald-600 text-white rounded px-3 py-1" disabled={busy} onClick={() => act({ action: "publish_recap" }, "Recap published on the match page. Nothing was sent.")}>
                  Publish Recap
                </button>
                <div className="text-gray-600">The Telegram summary may still be posted without the recap.</div>
              </div>
            )}
            {!canManage || !m ? (
              <div className="text-xs text-gray-600">An owner or admin posts the match summary to Telegram.</div>
            ) : !m.destinationConnected ? (
              <div className="text-xs text-gray-600">Select a connected Telegram group for this match to post the summary.</div>
            ) : (
              <>
                {readiness.summaryChanged && <div className="text-xs text-amber-700">The published Match Summary has changed.</div>}
                <PostButton state={m.summary} label="Match Summary" disabled={busy} primary onPost={postSummary} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
