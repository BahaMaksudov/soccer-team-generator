import * as React from "react";
import { cn } from "@/lib/cn";

/** UI-0 — form label (native <label>; no extra dependency). Presentation only. */
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn("text-sm font-semibold leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-60", className)} {...props} />
));
Label.displayName = "Label";

export { Label };
