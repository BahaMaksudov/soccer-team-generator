// import { NextResponse } from "next/server";
// import { prisma } from "@/lib/prisma";
// import { revalidatePath } from "next/cache";

// export async function GET() {
//   const row = await prisma.appSetting.findUnique({
//     where: { key: "teamName" },
//   });

//   return NextResponse.json({
//     teamName: row?.value?.trim() || process.env.TEAM_NAME || "New England Eagles",
//   });
// }

// export async function POST(req: Request) {
//   const body = await req.json().catch(() => ({}));
//   const nextName = String(body?.teamName ?? "").trim();

//   if (!nextName) {
//     return NextResponse.json({ error: "Team name is required" }, { status: 400 });
//   }

//   await prisma.appSetting.upsert({
//     where: { key: "teamName" },
//     update: { value: nextName },
//     create: { key: "teamName", value: nextName },
//   });

//   // Helps Next refresh immediately after save
//   revalidatePath("/");
//   revalidatePath("/admin");

//   return NextResponse.json({ ok: true });
// }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value?.trim() || process.env.TEAM_NAME || "New England Eagles",
  });
}

async function saveTeamName(req: Request) {
  const body = await req.json().catch(() => ({}));
  const nextName = String(body?.teamName ?? "").trim();

  if (!nextName) {
    return NextResponse.json({ error: "Team name is required" }, { status: 400 });
  }

  await prisma.appSetting.upsert({
    where: { key: "teamName" },
    update: { value: nextName },
    create: { key: "teamName", value: nextName },
  });

  // Helps Next refresh immediately after save (server components/pages)
  // revalidatePath("/");
  // revalidatePath("/admin");

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/players", "layout"); // if you have Players page


  return NextResponse.json({ ok: true, teamName: nextName });
}

// Your UI might call POST
export async function POST(req: Request) {
  return saveTeamName(req);
}

// Your UI currently calls PUT (this fixes 405)
export async function PUT(req: Request) {
  return saveTeamName(req);
}
