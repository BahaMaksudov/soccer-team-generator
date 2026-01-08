// import { prisma } from "@/lib/prisma";
// import { NextResponse } from "next/server";
// import { generateBalancedTeams } from "@/lib/teamGen";
// import { toDateOnlyUTC } from "@/lib/dateOnly";

// export async function POST(req: Request) {
//   const body = await req.json();

//   const teamCount = Number(body.teamCount);
//   const dateStr = String(body.date ?? "");
//   const selectedIds: string[] = Array.isArray(body.selectedIds) ? body.selectedIds : [];

//   if (!teamCount || teamCount < 2) return NextResponse.json({ error: "Number of teams must be at least 2." }, { status: 400 });
//   if (!dateStr) return NextResponse.json({ error: "Date is required." }, { status: 400 });
//   if (selectedIds.length === 0) return NextResponse.json({ error: "Select at least one player." }, { status: 400 });

//   const normalizedDate = toDateOnlyUTC(dateStr);

//   const selected = await prisma.player.findMany({ where: { id: { in: selectedIds }, isActive: true } });
//   if (selected.length === 0) return NextResponse.json({ error: "No active players selected." }, { status: 400 });

//   let teams;
//   try {
//     teams = generateBalancedTeams(selected, teamCount);
//   } catch (e: any) {
//     return NextResponse.json({ error: e?.message ?? "Failed to generate teams." }, { status: 400 });
//   }

//   return NextResponse.json({ date: normalizedDate.toISOString(), teams });
// }

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateBalancedTeams } from "@/lib/teamGen";
import { toDateOnlyUTC } from "@/lib/dateOnly";


export async function POST(req: Request) {
 const body = await req.json();
 const teamCount = Number(body.teamCount);
 const dateStr = String(body.date ?? "");
 const selectedIds: string[] = Array.isArray(body.selectedIds) ? body.selectedIds : [];
 // NEW: format 7 or 8
 const format: 7 | 8 = body.format === 8 || body.format === "8" ? 8 : 7;
 if (!teamCount || teamCount < 2) {
   return NextResponse.json({ error: "Number of teams must be at least 2." }, { status: 400 });
 }
 if (!dateStr) {
   return NextResponse.json({ error: "Date is required." }, { status: 400 });
 }
 if (selectedIds.length === 0) {
   return NextResponse.json({ error: "Select at least one player." }, { status: 400 });
 }
 const normalizedDate = toDateOnlyUTC(dateStr);
 const selected = await prisma.player.findMany({
   where: { id: { in: selectedIds }, isActive: true },
 });
 if (selected.length === 0) {
   return NextResponse.json({ error: "No active players selected." }, { status: 400 });
 }
 // ✅ Load weights from DB (AppSetting)
 const row = await prisma.appSetting.findUnique({ where: { key: "balanceWeights" } });
 let weights = undefined as any;
 if (row?.value) {
   try {
     weights = JSON.parse(row.value);
   } catch {
     weights = undefined;
   }
 }
 let teams;
 try {
   teams = generateBalancedTeams(selected as any, teamCount, format, weights);
 } catch (e: any) {
   return NextResponse.json({ error: e?.message ?? "Failed to generate teams." }, { status: 400 });
 }
 return NextResponse.json({ date: normalizedDate.toISOString(), teams });
}