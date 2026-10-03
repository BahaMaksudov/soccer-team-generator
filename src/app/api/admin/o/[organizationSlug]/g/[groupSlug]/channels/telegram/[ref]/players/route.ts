import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { changeTelegramChatScope, getTelegramChatScope } from "@/lib/telegramChatScope";

/**
 * M9-B — a Telegram chat's default player scope (OWNER/ADMIN; MEMBER → 404).
 * GET: scope + linked-voter suggestions (Player ids only). POST: add a Player.
 * DELETE: remove a Player. Saves only — nothing is sent.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; ref: string }>;

const badRef = () => NextResponse.json({ error: "Telegram group not found" }, { status: 404 });

async function handle(req: Request, params: Params, run: (ctx: Awaited<ReturnType<typeof requireTenantContextForSlugs>>, id: number) => Promise<NextResponse>) {
  const { ref, ...slugs } = await params;
  const id = Number(ref);
  try {
    const context = await requireTenantContextForSlugs(slugs);
    if (!Number.isInteger(id) || id <= 0) return badRef();
    return await run(context, id);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function GET(req: Request, { params }: { params: Params }) {
  return handle(req, params, (context, id) => getTelegramChatScope(context, id));
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  return handle(req, params, (context, id) => changeTelegramChatScope(context, id, req, "add"));
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  return handle(req, params, (context, id) => changeTelegramChatScope(context, id, req, "remove"));
}
