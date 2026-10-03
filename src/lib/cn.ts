import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * UI-0 — merge conditional class names; later Tailwind classes win over
 * conflicting earlier ones (tailwind-merge v2 = Tailwind 3 compatible).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
