import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { positionLabel } from "@/lib/labels";

function formatDate(d: Date) {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const page = Math.max(1, Number(sp.page ?? "1"));
  const pageSize = 4;

  const total = await prisma.teamGeneration.count();
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  const rows = await prisma.teamGeneration.findMany({
    orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: { id: true, date: true, updatedAt: true, teamsJson: true },
  });

  const items = rows.map((r) => ({
    id: r.id,
    date: r.date,
    updatedAt: r.updatedAt,
    teams: JSON.parse(r.teamsJson) as Array<{
      teamNumber: number;
      players: Array<{ id: string; firstName: string; lastName: string; position: string }>;
    }>,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Published Teams</h1>
        <div className="text-sm text-gray-500">Newest dates show on top.</div>
      </div>

      {items.length === 0 ? (
        <div className="text-gray-600">No teams published yet. (Admin: go to Admin and publish.)</div>
      ) : (
        <div className="space-y-6">
          {items.map((gen) => (
            <div key={gen.id} className="border rounded-xl overflow-hidden bg-white">
              <div className="p-4 bg-gray-50 border-b flex items-start gap-3">
                <div className="flex-1">
                  <div className="font-semibold">Teams for {formatDate(gen.date)}</div>
                  <div className="text-xs text-gray-500">
                    Last published: {gen.updatedAt.toLocaleString()}
                  </div>
                </div>
                <Link className="px-3 py-2 border rounded-md text-sm bg-white" href={`/print/${gen.id}`} target="_blank">
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
            href={`/?page=${page - 1}`}
          >
            Prev
          </Link>
          <div className="text-sm text-gray-600">Page {page} of {totalPages}</div>
          <Link
            className={`px-3 py-2 border rounded-md text-sm ${page >= totalPages ? "pointer-events-none opacity-50" : ""}`}
            href={`/?page=${page + 1}`}
          >
            Next
          </Link>
        </div>
      )}
    </div>
  );
}
