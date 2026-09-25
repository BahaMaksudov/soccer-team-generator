import { notFound, redirect } from "next/navigation";
import { resolveLegacyPrintRedirect } from "./data";

/**
 * Phase 2D.5F — legacy Print compatibility redirect.
 *
 * This page no longer renders TeamGeneration content directly — it
 * previously ran a fully unscoped `findUnique(id)` with no ownership
 * check at all (Phase 2D.5A §E/§R), and was separately found to throw
 * a runtime 500 on every request regardless of tenancy (Phase 2D.5E
 * §B: a Server Component passing `onClick` to a plain <button>). Both
 * problems disappear now that this route only ever determines a
 * redirect destination from the generation's own persisted ownership
 * (see ./data.ts) and sends the visitor to the canonical, tenant-safe
 * print page, which does the actual rendering.
 *
 * A missing generation and a foreign/inactive-Group generation both
 * produce the identical generic 404 — no existence-detail leak.
 */

type Params = Promise<{ id: string }>;

export default async function LegacyPrintRedirect({ params }: { params: Params }) {
  const { id } = await params;

  const dest = await resolveLegacyPrintRedirect(id);
  if (!dest) notFound();

  redirect(`/g/${dest.organizationSlug}/${dest.groupSlug}/print/${id}`);
}
