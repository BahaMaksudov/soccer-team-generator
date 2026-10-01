"use client";

import { useEffect, useState } from "react";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { roleLabel } from "@/lib/sports";

type View = {
  groupName: string;
  sportKey: string;
  teamName: string;
  generations: Array<{
    date: string;
    teams: Array<{ teamNumber: number; players: Array<{ firstName: string; lastName: string; position: string | null }> }>;
  }>;
};

export default function ShareView() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, "");
    if (!token) {
      setError("This link is not valid.");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/share/view", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.error || "This link is not valid.");
        else setView(data as View);
      } catch {
        setError("Could not load the teams. Please try again.");
      }
    })();
  }, []);

  if (error) {
    return (
      <div className="max-w-md mx-auto rounded-2xl border bg-white shadow-sm p-5">
        <h1 className="text-xl font-semibold mb-2">Teams</h1>
        <p className="text-sm text-gray-600">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="text-sm text-gray-500 p-5">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <h1 className="text-2xl font-semibold">{view.teamName || view.groupName}</h1>
        {view.teamName && view.teamName !== view.groupName && <p className="text-sm text-gray-600">{view.groupName}</p>}
      </div>
      {view.generations.length === 0 ? (
        <div className="rounded-2xl border bg-white shadow-sm p-5 text-sm text-gray-600">No published teams yet.</div>
      ) : (
        view.generations.map((g) => (
          <div key={g.date} className="rounded-2xl border bg-white shadow-sm p-5">
            <h2 className="font-semibold mb-3">{formatLongDateOnly(g.date)}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {g.teams.map((t) => (
                <div key={t.teamNumber} className="border rounded-xl p-3">
                  <div className="font-semibold mb-1">Team #{t.teamNumber}</div>
                  <ul className="list-disc pl-5 text-sm space-y-0.5">
                    {t.players.map((p, i) => (
                      <li key={i}>
                        {p.firstName} {p.lastName}
                        {p.position ? <span className="text-gray-600"> — {roleLabel(view.sportKey, p.position)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
