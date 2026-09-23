"use client";

/**
 * "Generate Teams (Preview)" controls — presentational only.
 *
 * generate()/publish()/clearPreview() all read and write page-owned
 * state (previewTeams, previewDate, selected, importedPollId,
 * mainMsg), so those functions stay in admin/page.tsx and are passed
 * down here as handlers, per the "correct architecture over maximum
 * extraction" guidance for this refactor.
 */
export default function GenerationControls({
  date,
  onDateChange,
  teamCount,
  onTeamCountChange,
  selectedCount,
  selectedGKCount,
  hasPreview,
  onGenerate,
  onPublish,
  onClear,
}: {
  date: string;
  onDateChange: (date: string) => void;
  teamCount: number;
  onTeamCountChange: (teamCount: number) => void;
  selectedCount: number;
  selectedGKCount: number;
  hasPreview: boolean;
  onGenerate: () => void;
  onPublish: () => void;
  onClear: () => void;
}) {
  return (
    <div className="border rounded-2xl p-5 space-y-4 bg-white shadow-sm mt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-900">Generate Teams (Preview)</div>
          <div className="text-xs text-slate-500 mt-1">
            Generate as many times as you want. Publish replaces any teams already published for this date.
          </div>
        </div>

        <div
          className={`text-xs px-2 py-1 rounded-full border ${
            hasPreview
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-slate-50 text-slate-600 border-slate-200"
          }`}
        >
          {hasPreview ? "Preview ready" : "Not generated"}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
          <input
            type="date"
            className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Number of teams</label>
          <input
            type="number"
            min={2}
            className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
            value={teamCount}
            onChange={(e) => onTeamCountChange(Number(e.target.value))}
          />

          {selectedGKCount < teamCount && (
            <div className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Note: Only <b>{selectedGKCount}</b> goalkeeper(s) selected for <b>{teamCount}</b> teams.
            </div>
          )}
        </div>

        <div className="flex items-end">
          <div className="flex gap-2 w-full">
            <button
              className="w-full rounded-lg py-2 font-semibold text-white bg-emerald-600 hover:bg-emerald-700"
              onClick={onGenerate}
            >
              Generate <span className="font-normal opacity-90">(Selected: {selectedCount})</span>
            </button>

            <button
              className={`w-full rounded-lg py-2 font-semibold text-white ${
                hasPreview ? "bg-sky-600 hover:bg-sky-700" : "bg-slate-300 cursor-not-allowed"
              }`}
              onClick={onPublish}
              disabled={!hasPreview}
            >
              Publish
            </button>

            <button
              className={`w-full rounded-lg py-2 font-semibold text-white ${
                hasPreview ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-300 cursor-not-allowed"
              }`}
              onClick={onClear}
              disabled={!hasPreview}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
