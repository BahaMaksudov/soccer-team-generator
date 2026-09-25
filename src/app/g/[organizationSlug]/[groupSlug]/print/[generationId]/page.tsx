import { notFound } from "next/navigation";
import Link from "next/link";
import { positionLabel } from "@/lib/labels";
import { loadPublicGroupPrintData } from "./data";
import PrintButton from "./PrintButton";

/**
 * Phase 2D.5E — canonical, tenant-safe public Print page.
 *
 * Deliberately a close copy of legacy src/app/print/[id]/page.tsx's
 * rendering (same layout, same @media print CSS, same table
 * structure) — not a shared component, matching the duplication
 * precedent already established for the canonical home page (Phase
 * 2D.5B report §M/§N). The two behavioral differences from legacy:
 * (1) the TeamGeneration lookup is ownership-constrained by the
 * resolved Group's id (see ./data.ts), and (2) the print button is a
 * small Client Component so it actually works — see ./PrintButton.tsx
 * for why.
 */

function formatDate(d: Date) {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

type Params = Promise<{ organizationSlug: string; groupSlug: string; generationId: string }>;

export default async function PublicGroupPrint({ params }: { params: Params }) {
  const { organizationSlug, groupSlug, generationId } = await params;

  const gen = await loadPublicGroupPrintData({ organizationSlug, groupSlug, generationId });
  if (!gen) notFound();

  return (
    <div className="p-6 space-y-4">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>

      <div className="no-print flex items-center gap-3">
        <PrintButton />
        <Link className="text-sm underline" href={`/g/${organizationSlug}/${groupSlug}`}>
          Back to Home
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="Team Logo" className="h-10 w-10 object-contain" />
        <div>
          <div className="text-2xl font-semibold">Teams for {formatDate(gen.date)}</div>
          <div className="text-xs text-gray-500 no-print">
            Last published: {new Date(gen.updatedAt).toLocaleString()}
          </div>
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
            {gen.teams.map((t) => (
              <tr key={t.teamNumber} className="border-t">
                <td className="p-3 font-semibold">#{t.teamNumber}</td>
                <td className="p-3">
                  <ul className="list-disc pl-5 space-y-1">
                    {t.players.map((p) => (
                      <li key={p.id}>
                        {p.firstName} {p.lastName} —{" "}
                        <span className="text-gray-700">{positionLabel(p.position)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500 no-print">
        Tip: In the print dialog, choose “Save as PDF”.
      </div>
    </div>
  );
}
