import { notFound } from "next/navigation";

// UI-3 — any otherwise-unmatched URL in this app-shell subtree 404s INSIDE the
// shell (segment not-found.tsx) instead of falling through to the bare root 404.
// Real routes always take precedence over this catch-all.
export default function MissingPage() {
  notFound();
}
