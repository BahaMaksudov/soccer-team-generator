// import { prisma } from "@/lib/prisma";
// import { NextResponse } from "next/server";
// import { toDateOnlyUTC } from "@/lib/dateOnly";

// export async function POST(req: Request) {
//   const body = await req.json();

//   const dateStr = String(body.date ?? "");
//   const teams = body.teams;

//   if (!dateStr) return NextResponse.json({ error: "Date is required." }, { status: 400 });
//   if (!Array.isArray(teams) || teams.length === 0) return NextResponse.json({ error: "Teams are required." }, { status: 400 });

//   const normalizedDate = toDateOnlyUTC(dateStr);

//   const saved = await prisma.teamGeneration.upsert({
//     where: { date: normalizedDate },
//     create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
//     update: { teamsJson: JSON.stringify(teams) },
//   });

//   return NextResponse.json({ ok: true, id: saved.id });
// }




// import { prisma } from "@/lib/prisma";
// import { NextResponse } from "next/server";
// import { toDateOnlyUTC } from "@/lib/dateOnly";

// export async function POST(req: Request) {
//   const body = await req.json();

//   const dateStr = String(body.date ?? "");
//   const teams = body.teams;

//   if (!dateStr) return NextResponse.json({ error: "Date is required." }, { status: 400 });
//   if (!Array.isArray(teams) || teams.length === 0) return NextResponse.json({ error: "Teams are required." }, { status: 400 });

//   const normalizedDate = toDateOnlyUTC(dateStr);

//   const saved = await prisma.teamGeneration.upsert({
//     where: { date: normalizedDate },
//     create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
//     update: { teamsJson: JSON.stringify(teams) },
//   });

//   return NextResponse.json({ ok: true, id: saved.id });
// }



import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";

export async function POST(req: Request) {
  const body = await req.json();

  const dateStr = String(body.date ?? "");
  const teams = body.teams;

  if (!dateStr) {
    return NextResponse.json({ error: "Date is required." }, { status: 400 });
  }
  if (!Array.isArray(teams) || teams.length === 0) {
    return NextResponse.json({ error: "Teams are required." }, { status: 400 });
  }

  const normalizedDate = toDateOnlyUTC(dateStr);

  const saved = await prisma.teamGeneration.upsert({
    where: { date: normalizedDate },
    create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
    update: { teamsJson: JSON.stringify(teams) },
  });

  // Home page likely reads published teams
  revalidatePath("/");

  return NextResponse.json({ ok: true, id: saved.id });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const dateStr = url.searchParams.get("date");

  if (!dateStr) {
    return NextResponse.json({ error: "date query param is required (YYYY-MM-DD)" }, { status: 400 });
  }

  // Delete everything in that UTC day (covers any stored time within the day)
  const start = toDateOnlyUTC(dateStr);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const result = await prisma.teamGeneration.deleteMany({
    where: {
      date: {
        gte: start,
        lt: end,
      },
    },
  });

  revalidatePath("/");

  return NextResponse.json({ ok: true, deleted: result.count, start, end });
}
