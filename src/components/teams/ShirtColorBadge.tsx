import { shirtColorOf } from "@/lib/shirtColors";
import { cn } from "@/lib/cn";

/**
 * A team's shirt color: a swatch (decorative; outlined so White stays visible, printed in color
 * where supported) and the color NAME — the name alone carries the meaning, so it reads in
 * black-and-white print and for color-blind viewers. Renders nothing for teams without a color.
 */
export function ShirtColorSwatch({ color, className }: { color: unknown; className?: string }) {
  const c = shirtColorOf(color);
  if (!c) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-3.5 shrink-0 rounded-full border border-foreground/40 [print-color-adjust:exact] [-webkit-print-color-adjust:exact]", className)}
      style={{ backgroundColor: c.swatch }}
    />
  );
}

export default function ShirtColorBadge({ color, className }: { color: unknown; className?: string }) {
  const c = shirtColorOf(color);
  if (!c) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", className)}>
      <ShirtColorSwatch color={c.id} />
      {c.label} Shirts
    </span>
  );
}
