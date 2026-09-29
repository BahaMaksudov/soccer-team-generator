import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { publishTeamsForContext, deletePublishedTeamsForContext } from "@/lib/publishTeams";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  // Phase 2D.6D.5E.1 — Telegram side effects are disabled on this flat
  // legacy route. Its close/post branch had no durable posting state,
  // no poll/date matching, and auto-targeted the newest open poll, so
  // it could duplicate or misdirect a canonical Close/Post delivery.
  // With `false`, any request carrying a pollId (e.g. from a stale
  // legacy tab) is rejected with 400 BEFORE any TeamGeneration write or
  // Telegram call. Telegram team delivery is canonical-only
  // (/api/admin/o/[org]/g/[group]/telegram/close-and-post).
  return publishTeamsForContext(context, req, { allowTelegramPollActions: false });
}

export async function DELETE(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return deletePublishedTeamsForContext(context, req);
}
