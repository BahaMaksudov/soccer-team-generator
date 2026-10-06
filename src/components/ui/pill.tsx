import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * UI-0 — rounded status pill (e.g. "Published", "Draft", "Needs update") and
 * SaveState, a pill for editor state. Presentation only: callers pass state
 * derived from real server data; nothing here decides or stores state.
 */
export type PillTone = "primary" | "accent" | "neutral" | "destructive";

const TONE: Record<PillTone, string> = {
  primary: "bg-secondary text-secondary-foreground",
  accent: "bg-accent/15 text-accent-foreground",
  neutral: "bg-muted text-muted-foreground",
  destructive: "bg-destructive/10 text-destructive",
};

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
}

const Pill = React.forwardRef<HTMLSpanElement, PillProps>(({ className, tone = "neutral", ...props }, ref) => (
  <span ref={ref} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold [&_svg]:size-3", TONE[tone], className)} {...props} />
));
Pill.displayName = "Pill";

export type SaveStateValue = "unsaved" | "saved" | "dirty";

/** "Not entered" / "Saved" / "Unsaved changes" — the caller computes the value (e.g. from resultEditorState). */
function SaveState({ state, savedLabel = "Saved", className }: { state: SaveStateValue; savedLabel?: string; className?: string }) {
  if (state === "dirty") return <Pill tone="accent" className={className}>Unsaved changes</Pill>;
  if (state === "saved")
    return (
      <Pill tone="primary" className={className}>
        <Check aria-hidden="true" />
        {savedLabel}
      </Pill>
    );
  return <Pill tone="neutral" className={className}>Not entered</Pill>;
}

export { Pill, SaveState };
