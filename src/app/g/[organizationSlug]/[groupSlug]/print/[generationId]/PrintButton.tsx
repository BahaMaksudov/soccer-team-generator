"use client";

/**
 * Phase 2D.5E — minimal interactivity wrapper.
 *
 * Legacy src/app/print/[id]/page.tsx puts `onClick={() => window.print()}`
 * directly on a <button> inside a Server Component with no "use client"
 * boundary anywhere in its tree. That throws at request time in this
 * Next.js version — "Event handlers cannot be passed to Client
 * Component props" — confirmed empirically while auditing this phase
 * (see Phase 2D.5E report §B): every request to legacy /print/[id]
 * currently returns HTTP 500, not just for canonical routes.
 *
 * Per this phase's explicit boundary, src/app/print/[id]/page.tsx
 * itself is NOT modified (deferred to Phase 2D.5F) — but the
 * canonical print page should not knowingly reproduce the same crash
 * for the same "Print / Save as PDF" affordance. This is the smallest
 * fix: isolate only the interactive button in its own Client
 * Component, exactly as Next.js's own error message recommends. No
 * PDF-generation infrastructure, no server-rendered PDFs — still just
 * window.print().
 */
export default function PrintButton() {
  return (
    <button
      className="px-3 py-2 border rounded-md text-sm"
      onClick={() => window.print()}
    >
      Print / Save as PDF
    </button>
  );
}
