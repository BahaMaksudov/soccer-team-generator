import Link from "next/link";
import { notFound } from "next/navigation";
import { positionLabel } from "@/lib/labels";
import { loadPublicGroupHomeData } from "./data";
import { buildCanonicalPrintHref } from "./printHref";

/**
 * Phase 2D.5B — canonical public Group home/history page.
 *
 * Deliberately a close copy of src/app/page.tsx's rendering, not a
 * shared component: the two pages will diverge further in Phase
 * 2D.5F (legacy `/` decision), so extracting a shared abstraction now
 * would be premature — some duplication is accepted temporarily and
 * flagged for cleanup rather than papered over. See Phase 2D.5B
 * report §N.
 *
 * The behavioral difference from `/`: every TeamGeneration query is
 * scoped to the URL-resolved Group (see ./data.ts). Print links
 * (restored in Phase 2D.5E) point at the canonical, tenant-safe print
 * route — never the legacy /print/[id], which has no ownership check
 * at all.
 */

function formatDate(value: Date | string) {
  const d = value instanceof Date ? value : new Date(value);
  // Always render as a calendar day in UTC (prevents 1-day shift)
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;
type SearchParams = Promise<{ page?: string }>;

export default async function PublicGroupHome({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  const { organizationSlug, groupSlug } = await params;
  const sp = (await searchParams) ?? {};

  const data = await loadPublicGroupHomeData({ organizationSlug, groupSlug, page: sp.page });
  if (!data) notFound();

  const { items, page, totalPages } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Published Teams</h1>
        <div className="text-sm text-gray-500">Newest dates show on top.</div>
      </div>

      {items.length === 0 ? (
        <div className="text-gray-600">No teams published yet.</div>
      ) : (
        <div className="space-y-6">
          {items.map((gen) => (
            <div key={gen.id} className="border rounded-xl overflow-hidden bg-white">
              <div className="p-4 bg-gray-50 border-b flex items-start gap-3">
                <div className="flex-1">
                  <div className="font-semibold">Teams for {formatDate(gen.date)}</div>
                  <div className="text-xs text-gray-500">
                    Last published:{" "}
                    {new Date(gen.updatedAt).toLocaleString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </div>
                </div>
                <Link
                  className="px-3 py-2 border rounded-md text-sm bg-white"
                  href={buildCanonicalPrintHref(organizationSlug, groupSlug, gen.id)}
                  target="_blank"
                >
                  Print / Save as PDF
                </Link>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white">
                    <tr>
                      <th className="text-left p-3 w-28">Team</th>
                      <th className="text-left p-3">Players (Name — Position)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gen.teams.map((t) => (
                      <tr key={t.teamNumber} className="border-t">
                        <td className="p-3 font-semibold">#{t.teamNumber}</td>
                        <td className="p-3">
                          <ul className="list-disc pl-5 space-y-1">
                            {t.players.map((p) => (
                              <li key={p.id}>
                                {p.firstName} {p.lastName} —{" "}
                                <span className="text-gray-600">{positionLabel(p.position)}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center gap-3">
          <Link
            className={`px-3 py-2 border rounded-md text-sm ${page <= 1 ? "pointer-events-none opacity-50" : ""}`}
            href={`/g/${organizationSlug}/${groupSlug}?page=${page - 1}`}
          >
            Prev
          </Link>
          <div className="text-sm text-gray-600">
            Page {page} of {totalPages}
          </div>
          <Link
            className={`px-3 py-2 border rounded-md text-sm ${page >= totalPages ? "pointer-events-none opacity-50" : ""}`}
            href={`/g/${organizationSlug}/${groupSlug}?page=${page + 1}`}
          >
            Next
          </Link>
        </div>
      )}
    </div>
  );
}
