import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/** UI-0 — compact label (e.g. sport, role, count). Non-interactive; presentation only. */
const badgeVariants = cva("inline-flex items-center gap-1 rounded-tbp-sm border px-2 py-0.5 text-xs font-semibold", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      accent: "border-transparent bg-accent/15 text-accent-foreground",
      destructive: "border-transparent bg-destructive text-destructive-foreground",
      outline: "border-border text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = "Badge";

export { Badge, badgeVariants };
