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
import { CircleCheck, CircleDashed, FileText, Medal, Megaphone, Send, Sparkles, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { focusRing, SectionCard, StateChip } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";

/**
 * M9-D — organizer post-game panel. SAVE ≠ PUBLISH ≠ SEND: only the "Post …",
 * and "Start MVP vote" buttons talk to Telegram, and only OWNER/ADMIN see them.
 * UI-4 — redesigned as four sections (#result, #mvp, #recap, #summary); the
 * logic, payloads and texts are unchanged. Match Summary remains the ONLY
 * post-game Telegram message.
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
  if (state === "posted") return <span className="text-sm font-semibold">{primary ? `${label} posted to Telegram.` : "Posted to Telegram."}</span>;
  if (state === "sending") return <span role="status" className="text-sm">Posting…</span>;
  const intent = state === "updated_available" ? "post_updated" : state === "uncertain" ? "retry_uncertain" : "post";
  const text = state === "updated_available" ? `Post Updated ${label} to Telegram` : state === "uncertain" ? `Retry posting ${label} (check the group first)` : `Post ${label} to Telegram`;
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-foreground hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-pitch disabled:opacity-60"
      disabled={disabled}
      onClick={() => onPost(intent)}
    >
      {text} <span className="text-xs font-normal">(sends a message)</span>
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

  if (pg.canceled)
    return (
      <SectionCard id="result" title="After the game">
        <p className="text-sm text-muted-foreground">This match is canceled — reopen it to record a result, MVP or recap.</p>
      </SectionCard>
    );
  if (pg.teamNumbers.length === 0)
    return (
      <SectionCard id="result" title="After the game">
        <p className="text-sm text-muted-foreground">
          {canManage ? "Publish teams for this match to record a result." : "The result, Player of the Match and recap appear here after the game."}
        </p>
      </SectionCard>
    );
  // UI-4A — MEMBER: read-only post-game status (every post-game command is OWNER/ADMIN, enforced server-side).
  if (!canManage) return <PostGameReadOnly pg={pg} />;

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
    <div className="space-y-6">

      {/* Result */}
      <SectionCard
        id="result"
        title="Result"
        icon={<Trophy className="size-5" />}
        action={pg.result?.published ? <StateChip tone="done">Published</StateChip> : pg.result ? <StateChip tone="pending">Saved, not published</StateChip> : <StateChip tone="neutral">Not entered</StateChip>}
      >
        <div className="flex flex-wrap gap-4">
          {pg.teamNumbers.map((n) => (
            <label key={n} className="flex flex-col items-center gap-1.5 text-sm font-semibold">
              Team {n}
              <input
                type="number"
                min={0}
                max={999}
                inputMode="numeric"
                className="h-16 w-20 rounded-tbp-xl border border-input bg-card text-center font-display text-3xl font-black tabular-nums focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
                value={scores[n] ?? ""}
                onChange={(e) => setScores({ ...scores, [n]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {editor.action ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !editor.valid}
              onClick={() =>
                act(
                  { action: "save_result", scores: pg.teamNumbers.map((n) => ({ teamNumber: n, score: Number(scores[n]) })) },
                  pg.result?.published ? "Result changes saved. Telegram was not updated." : "Result saved (not published)."
                )
              }
            >
              {editor.action === "SAVE_CHANGES" ? "Save Changes" : "Save Result"}
            </Button>
          ) : (
            <span className="text-xs font-semibold text-primary">Saved.</span>
          )}
          {editor.action === "SAVE_CHANGES" && <StateChip tone="pending">Unsaved changes</StateChip>}
          {pg.result && !pg.result.published && !editor.dirty && (
            <Button type="button" disabled={busy} onClick={() => act({ action: "publish_result" }, "Result published on the match page. Nothing was sent.")}>
              Publish Result
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Saving and publishing never send anything to Telegram.</p>
      </SectionCard>

      {/* Player of the Match — Player Vote (Telegram poll) or Organizer Selection; always a published participant, never free text */}
      <SectionCard
        id="mvp"
        title="Player of the Match"
        icon={<Medal className="size-5" />}
        action={pg.mvp?.published ? <StateChip tone="done">Published</StateChip> : <StateChip tone="neutral">Not published</StateChip>}
      >
        <div className="space-y-3 text-sm">
        {stage === "RESULT_NOT_PUBLISHED" && <p className="text-muted-foreground">Publish the result before choosing Player of the Match.</p>}
        {stage === "WAITING_FOR_MANAGER" && <p className="text-muted-foreground">An owner or admin decides Player of the Match for this match.</p>}

        {switchable && (
          <div className="space-y-2">
            <p className="font-semibold">Choose how Player of the Match will be decided:</p>
            <div role="group" aria-label="Player of the Match method" className="grid grid-cols-2 gap-1 rounded-tbp bg-muted p-1 sm:max-w-md">
              {(["PLAYER_VOTE", "ORGANIZER_SELECTION"] as const).map((mth) => (
                <button
                  key={mth}
                  type="button"
                  aria-pressed={chosenMethod === mth}
                  className={cn("min-h-10 rounded-tbp-sm px-3 text-sm font-semibold", chosenMethod === mth ? "bg-card shadow-card" : "text-muted-foreground hover:text-foreground", focusRing)}
                  onClick={() => setChosenMethod(mth)}
                >
                  {mth === "PLAYER_VOTE" ? "Player Vote" : "Organizer Selection"}
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "NEEDS_TELEGRAM_GROUP" && (
          <div className="space-y-1">
            <p>Player Vote runs as a Telegram poll among this match&apos;s players. Select a connected Telegram group for this match to start Player of the Match voting{switchable ? " — or use Organizer Selection, which needs no Telegram group." : "."}</p>
            <button type="button" className={cn("font-semibold text-primary underline", focusRing)} onClick={() => document.getElementById(MATCH_TELEGRAM_GROUP_SELECTOR_ID)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              Choose Telegram group
            </button>
          </div>
        )}
        {stage === "READY_TO_START" && m && (
          <div className="space-y-2">
            <p className="text-muted-foreground">Posts a Player of the Match poll to the match&apos;s Telegram group. Only players of the published teams can vote, and not for themselves.</p>
            {needsShortlist && (
              <fieldset className="space-y-1">
                <legend>Telegram polls list at most {pg.mvpMaxCandidates} players. Choose the shortlist ({shortlist.length}/{pg.mvpMaxCandidates}):</legend>
                <div className="flex flex-wrap gap-2">
                  {pg.participants.map((p) => (
                    <label key={p.playerId} className="flex min-h-9 items-center gap-1.5 rounded-full border border-input px-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={shortlist.includes(p.playerId)}
                        onChange={() => setShortlist((s) => (s.includes(p.playerId) ? s.filter((x) => x !== p.playerId) : s.length < pg.mvpMaxCandidates ? [...s, p.playerId] : s))}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <Button
              type="button"
              disabled={busy || (needsShortlist && shortlist.length < 2)}
              onClick={() => act({ action: "start_mvp", ...(needsShortlist ? { candidateIds: shortlist } : {}), ...(m.mvpPoll === "uncertain" ? { intent: "retry_uncertain" } : {}) }, "Player of the Match poll posted to Telegram.")}
            >
              <Send aria-hidden="true" />
              {m.mvpPoll === "uncertain" ? "Retry Player of the Match poll (check the group first)" : "Start Player of the Match Vote"} <span className="text-xs font-normal">(sends a poll)</span>
            </Button>
          </div>
        )}
        {(stage === "OPEN" || stage === "CLOSED" || (stage === "PUBLISHED" && pg.mvp?.method !== "ORGANIZER_SELECTION")) && pg.mvp?.started && (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              Player Vote · {pg.mvp.open ? "voting open" : "voting closed"} · {pg.mvp.validVotes} valid vote(s) of {pg.mvp.eligibleVoters} players
              {pg.mvp.answersNotCounted > 0 ? ` · ${pg.mvp.answersNotCounted} answer(s) not counted (unlinked, not a participant or self-vote)` : ""}
            </p>
            <ul className="divide-y divide-border rounded-tbp border border-border">
              {pg.mvp.candidates.map((c) => (
                <li key={c.playerId} className="flex items-center justify-between px-3 py-2">{c.name} — {c.votes}</li>
              ))}
            </ul>
          </div>
        )}
        {stage === "OPEN" && (
          <>
            <p className="text-xs text-muted-foreground">The method is locked to Player Vote while voting is open.</p>
            <Button type="button" variant="outline" disabled={busy} onClick={() => act({ action: "close_mvp" }, "Vote closed. Nothing was announced.")}>
              Close Vote
            </Button>
          </>
        )}
        {(stage === "CLOSED" || (stage === "PUBLISHED" && pg.mvp?.method !== "ORGANIZER_SELECTION")) && pg.mvp && (
          <div className="flex flex-wrap items-center gap-2">
            {pg.mvp.leaders.length === 1 && (
              <Button type="button" disabled={busy} onClick={() => act({ action: "publish_mvp" }, "Player of the Match published on the match page. Nothing was sent.")}>
                {pg.mvp.published ? "Republish" : "Publish Player of the Match"}
              </Button>
            )}
            {pg.mvp.leaders.length > 1 && (
              <>
                <StateChip tone="pending">Tied: {pg.mvp.candidates.filter((c) => pg.mvp!.leaders.includes(c.playerId)).map((c) => c.name).join(", ")}</StateChip>
                <Button type="button" variant="outline" disabled={busy} onClick={() => act({ action: "publish_mvp", tieBreak: { mode: "co" } }, "Co-Players of the Match published. Nothing was sent.")}>
                  Publish co-Players of the Match
                </Button>
                {pg.mvp.leaders.map((id) => (
                  <Button key={id} type="button" variant="outline" disabled={busy} onClick={() => act({ action: "publish_mvp", tieBreak: { mode: "pick", playerId: id } }, "Player of the Match published (organizer tie-break). Nothing was sent.")}>
                    Pick {pg.mvp!.candidates.find((c) => c.playerId === id)?.name}
                  </Button>
                ))}
              </>
            )}
            {pg.mvp.leaders.length === 0 && <span className="text-xs text-muted-foreground">The vote closed with no valid votes, so there is no Player of the Match to publish.</span>}
          </div>
        )}

        {stage === "SELECT_PLAYER" && (
          <div className="space-y-2">
            <label htmlFor="mvp-select" className="block">Select Player of the Match (players of this match&apos;s published teams). No Telegram group is needed.</label>
            <select id="mvp-select" className="h-11 w-full max-w-sm rounded-tbp-md border border-input bg-card px-3" value={selectPick} onChange={(e) => setSelectPick(e.target.value)}>
              <option value="">Select a player…</option>
              {pg.participants.map((p) => (
                <option key={p.playerId} value={p.playerId}>{p.name} — Team {p.teamNumber}</option>
              ))}
            </select>
            <div>
              <Button type="button" variant="outline" disabled={busy || !selectPick} onClick={() => act({ action: "save_mvp_selection", playerId: selectPick }, "Player of the Match selection saved — not published.")}>
                Save Selection
              </Button>
            </div>
          </div>
        )}
        {stage === "SELECTION_SAVED" && pg.mvp?.selection && (
          <div className="space-y-2">
            <p>
              Organizer Selection: <b>{pg.mvp.selection.name}</b>{pg.mvp.selection.teamNumber ? ` — Team ${pg.mvp.selection.teamNumber}` : ""} · saved, not published.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => act({ action: "publish_mvp" }, "Player of the Match published on the match page. Nothing was sent.")}>
                Publish Player of the Match
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => act({ action: "reset_mvp_selection" }, "Selection reset. Choose how Player of the Match will be decided.")}>
                Change / reset selection
              </Button>
            </div>
          </div>
        )}

        {stage === "PUBLISHED" && pg.mvp && (
          <div className="space-y-1">
            <p className="flex items-center gap-2 font-semibold">
              <Medal className="size-4 text-accent" aria-hidden="true" />
              Published: {pg.mvp.winners.join(", ")}
              {pg.mvp.method === "ORGANIZER_SELECTION" ? " (organizer selection)" : pg.mvp.decision === "ORGANIZER_TIEBREAK" ? " (organizer tie-break)" : ""}
            </p>
            <p className="text-xs text-muted-foreground">It is sent to Telegram with the Match Summary below.</p>
          </div>
        )}
        </div>
      </SectionCard>

      {/* Recap */}
      <SectionCard
        id="recap"
        title="Match Recap"
        icon={<FileText className="size-5" />}
        action={pg.recap?.published ? <StateChip tone="done">Published</StateChip> : pg.recap?.content ? <StateChip tone="pending">Saved, not published</StateChip> : <StateChip tone="neutral">Not written</StateChip>}
      >
        <div className="space-y-3 text-sm">
        {!pg.standardRecap ? (
          <p className="text-muted-foreground">Publish the result before writing the recap.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || generating || !pg.aiConfigured || pendingReplace !== null}
                title={pg.aiConfigured ? undefined : "AI is not configured"}
                onClick={() => requestReplace("ai")}
              >
                <Sparkles aria-hidden="true" />
                {generating ? "Generating…" : aiButtonLabel(aiGenerated)}
              </Button>
              <Button type="button" variant="outline" disabled={busy || generating || pendingReplace !== null} onClick={() => requestReplace("standard")}>
                Use standard recap
              </Button>
            </div>
            {pendingReplace && (
              <div role="alertdialog" aria-labelledby="recap-replace-q" className="space-y-2 rounded-tbp border border-accent/40 bg-accent/10 p-3">
                <p id="recap-replace-q">{pendingReplace === "ai" ? "Regenerating" : "Using the standard recap"} will replace your current unsaved recap. Continue?</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPendingReplace(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const kind = pendingReplace;
                      setPendingReplace(null);
                      if (kind === "ai") void runGenerate();
                      else applyStandardRecap();
                    }}
                  >
                    {pendingReplace === "ai" ? (aiGenerated ? "Regenerate" : "Generate") : "Replace"}
                  </Button>
                </div>
              </div>
            )}
            {!pg.aiConfigured && <p className="text-xs text-muted-foreground">AI recaps are not set up; the standard recap is always available.</p>}
            {aiMessage && <p role="alert" className="text-xs text-destructive">{aiMessage}</p>}
            <label htmlFor="recap-text" className="sr-only">Recap text</label>
            <textarea id="recap-text" className="w-full rounded-tbp-md border border-input bg-card p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={5} maxLength={1200} value={recapText} onChange={(e) => setRecapText(e.target.value)} placeholder="Recap text" />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy || !recapText.trim()} onClick={() => act({ action: "save_recap", content: recapText }, pg.recap?.published ? "Recap updated. Telegram was not updated." : "Recap saved (not published).")}>
                Save Recap
              </Button>
              {pg.recap?.content && !pg.recap.published && (
                <Button type="button" disabled={busy} onClick={() => act({ action: "publish_recap" }, "Recap published on the match page. Nothing was sent.")}>
                  Publish Recap
                </Button>
              )}
            </div>
          </>
        )}
        </div>
      </SectionCard>

      {/* Match Summary — the ONLY post-game Telegram message (published data only; sending is separate from publishing) */}
      <section id="summary" aria-labelledby="summary-heading" className="scroll-mt-20 space-y-3 rounded-tbp-2xl bg-pitch p-4 text-pitch-foreground shadow-lift pitch-lines sm:p-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-tbp-sm bg-accent text-accent-foreground" aria-hidden="true">
            <Megaphone className="size-5" />
          </span>
          <div>
            <h2 id="summary-heading" className="text-lg font-extrabold">Match Summary</h2>
            <p className="text-sm opacity-80">Send the published result, Player of the Match and recap together in one Telegram message.</p>
          </div>
        </div>
        {!pg.result?.published ? (
          <p className="text-sm opacity-85">Publish the result before posting the match summary.</p>
        ) : (
          <>
            <div className="rounded-tbp bg-pitch-foreground/10 p-3 text-sm">
              <p className="font-semibold">Ready to send:</p>
              <ul className="mt-1 space-y-1">
                {readiness.items.map((it) => (
                  <li key={it.key} className="flex items-center gap-2">
                    {it.included ? <CircleCheck className="size-4 shrink-0 text-accent" aria-hidden="true" /> : <CircleDashed className="size-4 shrink-0 opacity-60" aria-hidden="true" />}
                    <span>
                      <span className="sr-only">{it.included ? "Included: " : "Not included: "}</span>
                      {it.label}
                      {it.note ? ` — ${it.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {readiness.publishRecapShortcut && (
              <div className="space-y-2 rounded-tbp bg-card p-3 text-sm text-card-foreground">
                <p>Match recap is saved but not published. Publish it to include it in the Match Summary.</p>
                <Button type="button" size="sm" disabled={busy} onClick={() => act({ action: "publish_recap" }, "Recap published on the match page. Nothing was sent.")}>
                  Publish Recap
                </Button>
                <p className="text-xs text-muted-foreground">The Telegram summary may still be posted without the recap.</p>
              </div>
            )}
            {!canManage || !m ? (
              <p className="text-sm opacity-85">An owner or admin posts the match summary to Telegram.</p>
            ) : !m.destinationConnected ? (
              <p className="text-sm opacity-85">Select a connected Telegram group for this match to post the summary.</p>
            ) : (
              <>
                {readiness.summaryChanged && <p className="text-sm font-semibold text-accent">The published Match Summary has changed.</p>}
                <PostButton state={m.summary} label="Match Summary" disabled={busy} primary onPost={postSummary} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** UI-4A — read-only post-game view for MEMBER: state and content, no editors, no send. */
function PostGameReadOnly({ pg }: { pg: PostGameView }) {
  const readiness = summaryReadiness(pg, false);
  return (
    <div className="space-y-6">
      <SectionCard
        id="result"
        title="Result"
        icon={<Trophy className="size-5" />}
        action={pg.result?.published ? <StateChip tone="done">Published</StateChip> : pg.result ? <StateChip tone="pending">Saved, not published</StateChip> : <StateChip tone="neutral">Not entered</StateChip>}
      >
        {pg.result ? (
          <ul className="flex flex-wrap gap-4" aria-label="Score">
            {pg.result.scores.map((sc) => (
              <li key={sc.teamNumber} className="flex flex-col items-center gap-1 text-sm font-semibold">
                Team {sc.teamNumber}
                <span className="grid h-16 w-20 place-items-center rounded-tbp-xl border border-border bg-muted font-display text-3xl font-black tabular-nums">{sc.score}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No result yet.</p>
        )}
      </SectionCard>
      <SectionCard
        id="mvp"
        title="Player of the Match"
        icon={<Medal className="size-5" />}
        action={pg.mvp?.published ? <StateChip tone="done">Published</StateChip> : <StateChip tone="neutral">Not published</StateChip>}
      >
        <p className="text-sm">
          {pg.mvp?.published
            ? `Player of the Match: ${pg.mvp.winners.join(", ")}`
            : pg.mvp?.open
              ? "Player vote is open in the match's Telegram group."
              : "An owner or admin decides Player of the Match for this match."}
        </p>
      </SectionCard>
      <SectionCard
        id="recap"
        title="Match Recap"
        icon={<FileText className="size-5" />}
        action={pg.recap?.published ? <StateChip tone="done">Published</StateChip> : pg.recap?.content ? <StateChip tone="pending">Saved, not published</StateChip> : <StateChip tone="neutral">Not written</StateChip>}
      >
        {pg.recap?.content ? <p className="whitespace-pre-line text-sm">{pg.recap.content}</p> : <p className="text-sm text-muted-foreground">No recap yet.</p>}
      </SectionCard>
      <section id="summary" aria-labelledby="summary-heading" className="scroll-mt-20 space-y-3 rounded-tbp-2xl bg-pitch p-4 text-pitch-foreground shadow-lift pitch-lines sm:p-5">
        <h2 id="summary-heading" className="text-lg font-extrabold">Match Summary</h2>
        <ul className="space-y-1 text-sm">
          {readiness.items.map((it) => (
            <li key={it.key} className="flex items-center gap-2">
              {it.included ? <CircleCheck className="size-4 shrink-0 text-accent" aria-hidden="true" /> : <CircleDashed className="size-4 shrink-0 opacity-60" aria-hidden="true" />}
              <span>
                <span className="sr-only">{it.included ? "Included: " : "Not included: "}</span>
                {it.label}
                {it.note ? ` — ${it.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm opacity-85">An owner or admin posts the match summary to Telegram.</p>
      </section>
    </div>
  );
}
