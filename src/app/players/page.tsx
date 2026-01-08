import { Suspense } from "react";
import PlayersClient from "./players-client";

export const dynamic = "force-dynamic"; // recommended so Vercel doesn't try to fully static prerender

export default function PlayersPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-600">Loading players…</div>}>
      <PlayersClient />
    </Suspense>
  );
}