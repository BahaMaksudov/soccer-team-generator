"use client";

import type { TgPollItem } from "../types";

/**
 * "Import from Telegram Poll" — presentational only.
 *
 * This section is intentionally NOT self-contained: importing a poll
 * writes into page-owned `selected` (player checkboxes), `previewDate`
 * (via the poll's real pollDate — see admin/page.tsx), and
 * `importedPollId` (read later by publish()). Splitting that logic
 * into this component would require synchronizing three pieces of
 * page state back out of it, which is exactly the kind of
 * cross-component synchronization the refactor should avoid. So all
 * state and the import/refresh logic stay in the page; this component
 * just renders it and delegates events upward.
 */
export default function TelegramPollImport({
  tgPolls,
  selectedPollId,
  onSelectPoll,
  onRefreshPolls,
  onImport,
  importMsg,
}: {
  tgPolls: TgPollItem[];
  selectedPollId: string;
  onSelectPoll: (pollId: string) => void;
  onRefreshPolls: () => void;
  onImport: () => void;
  importMsg: string | null;
}) {
  return (
    <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">Import from Telegram Poll</div>
          <div className="text-xs text-gray-500">
            Select a Poll. We’ll select all players who voted ✅ Playing (option index 0).
          </div>
        </div>

        <button className="border rounded-md px-3 py-2 text-sm bg-white" onClick={onRefreshPolls} type="button">
          Refresh Polls
        </button>
      </div>

      {importMsg && <div className="text-sm text-blue-700">{importMsg}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="md:col-span-2">
          <label className="block text-sm mb-1">Poll</label>

          <select
            className="border rounded-md px-3 py-2 w-full bg-white"
            value={selectedPollId}
            onChange={(e) => onSelectPoll(e.target.value)}
          >
            {tgPolls.length === 0 ? (
              <option value="">No polls found</option>
            ) : (
              tgPolls.map((p) => (
                <option key={p.pollId} value={p.pollId}>
                  {p.chatTitle} — {p.question || p.pollId} {p.isClosed ? "[closed]" : "[open]"}
                </option>
              ))
            )}
          </select>

          <div className="text-xs text-gray-500 mt-1">If you don’t see your poll, hit Refresh Polls.</div>
        </div>

        <button
          className="bg-indigo-600 text-white rounded-md py-2 disabled:opacity-60"
          onClick={onImport}
          disabled={!selectedPollId}
          type="button"
        >
          Import & Select Players
        </button>
      </div>
    </div>
  );
}
