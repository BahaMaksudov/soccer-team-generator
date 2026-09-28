import { NextRequest } from "next/server";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { updatePlayer, deletePlayer } from "@/lib/playerCrud";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const { id } = await params;
  return updatePlayer(context, id, req);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const { id } = await params;
  return deletePlayer(context, id);
}
