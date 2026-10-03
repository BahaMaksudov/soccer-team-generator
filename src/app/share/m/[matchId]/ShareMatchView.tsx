"use client";

import { useEffect, useState } from "react";
import PlayerMatchCard from "@/app/components/PlayerMatchCard";
import type { PlayerMatchView } from "@/lib/matchPage";

export default function ShareMatchView({ matchId }: { matchId: string }) {
  const [view, setView] = useState<PlayerMatchView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, "");
    if (!token) {
      setError("This link is not valid.");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/share/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, matchId }),
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.error || "This link is not valid.");
        else setView(data as PlayerMatchView);
      } catch {
        setError("Could not load the match. Please try again.");
      }
    })();
  }, [matchId]);

  if (error) {
    return (
      <div className="max-w-md mx-auto rounded-2xl border bg-white shadow-sm p-5">
        <h1 className="text-xl font-semibold mb-2">Match</h1>
        <p className="text-sm text-gray-600">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="text-sm text-gray-500 p-5">Loading…</div>;
  return <PlayerMatchCard view={view} signInHref="/login" />;
}
