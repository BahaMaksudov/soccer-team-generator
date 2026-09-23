"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";

import type { Player, TgPollItem, GeneratedTeam } from "./types";
import TeamSettings from "./components/TeamSettings";
import TelegramUserLinks from "./components/TelegramUserLinks";
import TelegramPollImport from "./components/TelegramPollImport";
import PlayerSelection from "./components/PlayerSelection";
import GenerationControls from "./components/GenerationControls";
import TeamPreview from "./components/TeamPreview";
import DeletePublishedTeams from "./components/DeletePublishedTeams";

/**
 * Admin page — orchestration/container only (Phase 1.5 structural
 * refactor). State that genuinely spans multiple sections stays here:
 *
 *   - players / selected / selectedIds: needed by player selection,
 *     Telegram user linking (dropdown), and generation (GK count,
 *     request body).
 *   - previewTeams / previewDate: written by generate/publish/clear,
 *     read by the preview and by publish().
 *   - selectedPollId / pollIdInput / importedPollId: owned here
 *     because publish() reads them directly to close/post to the
 *     right Telegram poll.
 *   - mainMsg: the single shared success/error banner, written by
 *     Team Settings, player CRUD, generate, and publish.
 *
 * Sections with no cross-section dependencies (Team Settings, Telegram
 * user linking, Delete Published Teams) own their state entirely and
 * are rendered as self-contained components below.
 */
export default function AdminPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [teamCount, setTeamCount] = useState(2);
  const [date, setDate] = useState<string>(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  });

  const [mainMsg, setMainMsg] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const [previewTeams, setPreviewTeams] = useState<GeneratedTeam[] | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);

  const [pollIdInput, setPollIdInput] = useState("");
  const [importedPollId, setImportedPollId] = useState<string>("");

  const topMsgRef = useRef<HTMLDivElement | null>(null);

  const [tgPolls, setTgPolls] = useState<TgPollItem[]>([]);
  const [selectedPollId, setSelectedPollId] = useState<string>("");

  async function loadPlayers() {
    setMainMsg(null);
    const res = await fetch("/api/admin/players", { cache: "no-store" });
    if (!res.ok) {
      setMainMsg("You must be logged in as admin.");
      return;
    }
    const data = await res.json();
    setPlayers(data);
  }

  async function loadTelegramPolls() {
    try {
      const res = await fetch("/api/admin/telegram/polls", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const polls = Array.isArray(data?.polls) ? data.polls : [];
      setTgPolls(polls);

      // auto-select newest poll if nothing selected yet
      if (!selectedPollId && polls.length > 0) {
        setSelectedPollId(polls[0].pollId);
        setPollIdInput(polls[0].pollId); // keep pollIdInput in sync
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadPlayers();
    loadTelegramPolls();
  }, []);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  const selectedGKCount = useMemo(() => {
    const sel = new Set(selectedIds);
    return players.filter((p) => sel.has(p.id) && p.position === "GOALKEEPER" && p.isActive).length;
  }, [players, selectedIds]);

  function handleSelectPoll(pollId: string) {
    setSelectedPollId(pollId);
    setPollIdInput(pollId); // keep existing import function working
    setImportMsg(null);
  }

  async function generate() {
    setMainMsg(null);
    const res = await fetch("/api/admin/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamCount, date: new Date(date).toISOString(), selectedIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMainMsg(data?.error ?? "Failed to generate");
      return;
    }
    setPreviewTeams(data.teams);
    setPreviewDate(data.date);
    setMainMsg("Preview generated. If it looks good, click Publish. You can regenerate multiple times.");
  }

  async function publish() {
    setMainMsg(null);
    if (!previewTeams || !previewDate) {
      setMainMsg("Generate teams first, then publish.");
      return;
    }

    const pollId = importedPollId || pollIdInput.trim(); // fallback if you didn't import but pasted it

    const res = await fetch("/api/admin/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: previewDate,
        teams: previewTeams,
        pollId, // so the API can close it
        closePoll: true,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setMainMsg(data?.error ?? "Failed to publish");
      return;
    }

    let pollMsg = "";
    switch (data?.pollStatus) {
      case "closed_now":
        pollMsg = " Poll closed ✅";
        break;

      case "already_closed":
        pollMsg = " Poll was already closed ✅";
        break;

      case "missing_message_or_chat":
        pollMsg = " Poll not closed (missing chat/message info).";
        break;

      case "poll_not_found_in_db":
        pollMsg = " Poll not closed (pollId not found in DB).";
        break;

      case "token_missing":
        pollMsg = " Poll not closed (TELEGRAM_BOT_TOKEN missing).";
        break;

      case "close_failed":
        pollMsg = " Poll close failed (Telegram error).";
        break;

      case "not_requested":
      case "skipped":
      default:
        pollMsg = ""; // don't show anything
        break;
    }

    setMainMsg(`✅ Published! Home page updated.${pollMsg}`);

    setTimeout(() => {
      topMsgRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      topMsgRef.current?.focus();
    }, 0);
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    setMainMsg("Preview cleared.");
  }

  async function importFromTelegramPoll() {
    setImportMsg(null);

    const pid = (selectedPollId || pollIdInput).trim();
    if (!pid) {
      setImportMsg("Poll ID is required.");
      return;
    }

    // Auto-set preview date from the selected poll's real game date.
    // selectedPoll.pollDate is the machine-readable "YYYY-MM-DD" form —
    // previewDate expects exactly that shape, so no parsing needed here.
    const selectedPoll = tgPolls.find((p) => p.pollId === pid);
    if (selectedPoll?.pollDate) {
      setPreviewDate(selectedPoll.pollDate);
    }

    const res = await fetch("/api/admin/telegram/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollId: pid }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setImportMsg(data?.error ?? "Failed to import from Telegram poll");
      return;
    }

    setImportedPollId(pid);

    const ids: string[] = Array.isArray(data.selectedPlayerIds) ? data.selectedPlayerIds : [];
    setSelected(() => {
      const next: Record<string, boolean> = {};
      for (const id of ids) next[id] = true;
      return next;
    });

    if (data.missingUserIds?.length) {
      setImportMsg(
        `✅ Imported. Missing links for ${data.missingUserIds.length} Telegram user(s). Link them above.`
      );
    } else {
      setImportMsg("✅ Imported & selected players from poll.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Admin</h1>

          <div className="ml-auto flex items-center gap-4">
            <Link className="text-sm underline" href="/admin/settings">
              Settings
            </Link>

            <Link className="text-sm underline" href="/admin/telegram">
              Telegram
            </Link>

            <button className="text-sm underline" onClick={() => signOut({ callbackUrl: "/" })}>
              Sign out
            </button>
          </div>
        </div>

        <div ref={topMsgRef} tabIndex={-1} className="mb-4"></div>

        {mainMsg && <div className="text-sm text-blue-700 mt-2">{mainMsg}</div>}

        <TeamSettings onMessage={setMainMsg} />

        <TelegramUserLinks players={players} />

        <TelegramPollImport
          tgPolls={tgPolls}
          selectedPollId={selectedPollId}
          onSelectPoll={handleSelectPoll}
          onRefreshPolls={loadTelegramPolls}
          onImport={importFromTelegramPoll}
          importMsg={importMsg}
        />

        <PlayerSelection
          players={players}
          selected={selected}
          setSelected={setSelected}
          selectedIds={selectedIds}
          refreshPlayers={loadPlayers}
          onMessage={setMainMsg}
        />

        <GenerationControls
          date={date}
          onDateChange={setDate}
          teamCount={teamCount}
          onTeamCountChange={setTeamCount}
          selectedCount={selectedIds.length}
          selectedGKCount={selectedGKCount}
          hasPreview={!!previewTeams}
          onGenerate={generate}
          onPublish={publish}
          onClear={clearPreview}
        />

        <DeletePublishedTeams />

        {previewTeams && previewDate && <TeamPreview previewTeams={previewTeams} previewDate={previewDate} />}
      </div>
    </div>
  );
}
