import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/components/game-day/parts";

/**
 * M9.3 — the organizer's per-player attendance buttons in the Match Workspace.
 *
 * The highlighted button is the player's EFFECTIVE status exactly as the
 * server computed it (organizer override, else the player's own answer from
 * the Match Link / web / Telegram) — never client-only state. No response →
 * all three neutral. Every button stays clickable: clicking sets an organizer
 * override (the existing endpoint). The selected state is conveyed by
 * aria-pressed and a check mark, not by color alone.
 */
export type AttendanceStatus = "PLAYING" | "MAYBE" | "NOT_PLAYING";

export const ATTENDANCE_OPTIONS: Array<{ status: AttendanceStatus; label: string }> = [
  { status: "PLAYING", label: "Playing" },
  { status: "MAYBE", label: "Maybe" },
  { status: "NOT_PLAYING", label: "Not playing" },
];

const SELECTED: Record<AttendanceStatus, string> = {
  PLAYING: "border-primary bg-primary text-primary-foreground", // green
  MAYBE: "border-accent bg-accent text-accent-foreground", // amber
  NOT_PLAYING: "border-destructive/50 bg-destructive/10 text-destructive", // muted red
};
const NEUTRAL = "border-input bg-card text-foreground hover:bg-muted";

export function attendanceButtonClass(effective: AttendanceStatus | null, option: AttendanceStatus): string {
  return effective === option ? SELECTED[option] : NEUTRAL;
}

export function AttendanceStatusButtons({
  playerName,
  effective,
  busy,
  onSet,
}: {
  playerName: string;
  /** Server-authoritative effective status (null = no response). */
  effective: AttendanceStatus | null;
  busy: boolean;
  onSet: (status: AttendanceStatus) => void;
}) {
  return (
    <div role="group" aria-label={`Set attendance for ${playerName}`} className="flex flex-wrap items-center gap-1">
      {ATTENDANCE_OPTIONS.map(({ status, label }) => {
        const on = effective === status;
        return (
          <button
            key={status}
            type="button"
            disabled={busy}
            aria-pressed={on}
            className={cn("inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs font-semibold disabled:opacity-50", attendanceButtonClass(effective, status), focusRing)}
            onClick={() => onSet(status)}
          >
            {on && <Check className="size-3.5" aria-hidden="true" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
