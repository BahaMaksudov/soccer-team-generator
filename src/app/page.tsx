import Link from "next/link";
import { positionLabel } from "@/lib/labels";

type Generation = {
  id: string;
  date: string;
  updatedAt: string;
  teams: Array<{
    teamNumber: number;
    players: Array<{ id: string; firstName: string; lastName: string; position: string }>;
  }>;
};

function formatDate(d: string) {
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// ✅ Use relative URL so it works on Vercel automatically
async function getGenerations(page: number) {
  const res = await fetch(`/api/public/team-generations?page=${page}&pageSize=4`, {
    cache: "no-store",
  });
  if (!res.ok) {
    return { page, totalPages: 1, items: [] as Generation[] };
  }
  return res.json() as Promise<{ page: number; totalPages: number; items: Generation[] }>;
}

// ✅ Next 15.5: searchParams is a Promise in PageProps
type SearchParams = Promise<{ page?: string }>;

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp?.page ?? "1") || 1);

  const data = await getGenerations(page);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Published Teams</h1>
        <div className="text-sm text-gray-500">Newest dates show on top.</div>
      </div>

      {data.items.length === 0 ? (
        <div className="text-gray-600">No teams published yet. (Admin: go to Admin and publish.)</div>
      ) : (
        <div className="space-y-6">
          {data.items.map((gen) => (
            <div key={gen.id} className="border rounded-xl overflow-hidden bg-white">
              <div className="p-4 bg-gray-50 border-b flex items-start gap-3">
                <div className="flex-1">
                  <div className="font-semibold">Teams for {formatDate(gen.date)}</div>
                  <div className="text-xs text-gray-500">
                    Last published: {new Date(gen.updatedAt).toLocaleString()}
                  </div>
                </div>

                <Link
                  className="px-3 py-2 border rounded-md text-sm bg-white hover:bg-slate-50 transition"
                  href={`/print/${gen.id}`}
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
                      <tr key={t.teamNumber} className="border-t hover:bg-slate-50 transition">
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

      {data.totalPages > 1 && (
        <div className="flex items-center gap-3">
          <Link
            className={`px-3 py-2 border rounded-md text-sm hover:bg-slate-50 transition ${
              page <= 1 ? "pointer-events-none opacity-50" : ""
            }`}
            href={`/?page=${page - 1}`}
          >
            Prev
          </Link>

          <div className="text-sm text-gray-600">
            Page {page} of {data.totalPages}
          </div>

          <Link
            className={`px-3 py-2 border rounded-md text-sm hover:bg-slate-50 transition ${
              page >= data.totalPages ? "pointer-events-none opacity-50" : ""
            }`}
            href={`/?page=${page + 1}`}
          >
            Next
          </Link>
        </div>
      )}
    </div>
  );
}
