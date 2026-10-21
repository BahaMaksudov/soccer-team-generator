"use client";

/**
 * M12-A — last-resort boundary for errors in the ROOT layout itself (it replaces
 * the whole document, so it renders its own <html>/<body> with inline styles —
 * the app's CSS may not be available). No error text or stack is shown.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#f8fafc", color: "#0f172a" }}>
        <main role="alert" style={{ maxWidth: 420, margin: "64px auto", padding: "0 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#475569" }}>TeamBalance Pro couldn&apos;t load. Nothing was changed. Please try again in a moment.</p>
          {error.digest && <p style={{ fontSize: 12, color: "#64748b" }}>Reference: {error.digest}</p>}
          <button type="button" onClick={() => reset()} style={{ height: 44, padding: "0 16px", borderRadius: 8, border: 0, background: "#0f766e", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
