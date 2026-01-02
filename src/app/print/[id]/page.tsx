import { prisma } from "@/lib/prisma";
import { positionLabel } from "@/lib/labels";
import Link from "next/link";


function formatDate(d: Date) {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default async function PrintPage({ params }: { params: { id: string } }) {
  const gen = await prisma.teamGeneration.findUnique({ where: { id: params.id } });
  if (!gen) return <div className="p-6">Not found.</div>;

  const teams = JSON.parse(gen.teamsJson) as Array<{ teamNumber: number; players: Array<{ id: string; firstName: string; lastName: string; position: string }> }>;

  return (
    <div className="p-6 space-y-4">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>

      <div className="no-print flex items-center gap-3">
        <button className="px-3 py-2 border rounded-md text-sm" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        <Link className="text-sm underline" href="/">Back to Home</Link>
      </div>

      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="Team Logo" className="h-10 w-10 object-contain" />
        <div>
          <div className="text-2xl font-semibold">Teams for {formatDate(gen.date)}</div>
          <div className="text-xs text-gray-500 no-print">Last published: {new Date(gen.updatedAt).toLocaleString()}</div>
        </div>
      </div>

      <div className="border rounded-xl overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3 w-28">Team</th>
              <th className="text-left p-3">Players (Name — Position)</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.teamNumber} className="border-t">
                <td className="p-3 font-semibold">#{t.teamNumber}</td>
                <td className="p-3">
                  <ul className="list-disc pl-5 space-y-1">
                    {t.players.map((p) => (
                      <li key={p.id}>
                        {p.firstName} {p.lastName} — <span className="text-gray-700">{positionLabel(p.position)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500 no-print">Tip: In the print dialog, choose “Save as PDF”.</div>
    </div>
  );
}
