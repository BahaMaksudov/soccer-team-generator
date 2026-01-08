// import { NextResponse } from "next/server";
// import { prisma } from "@/lib/prisma";
// import type { Position, Rating } from "@prisma/client";

// const ratingWeight: Record<Rating, number> = {
//   FAIR: 1,
//   GOOD: 2,
//   VERY_GOOD: 3,
//   EXCELLENT: 4,
// };

// function positionWeight(pos: Position): number {
//   switch (pos) {
//     case "DEFENDER":
//       return 1;
//     case "MIDFIELDER":
//       return 2;
//     case "FORWARD":
//       return 2;
//     case "GOALKEEPER":
//       return 2;
//     default:
//       return 1;
//   }
// }

// function clampStamina(v: any): number {
//   const n = Number(v);
//   return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
// }

// // Overall score: rating dominates, stamina + role add smaller boost
// function overallScore(p: { rating: Rating; stamina: number; position: Position }) {
//   const r = ratingWeight[p.rating];      // 1..4
//   const s = clampStamina(p.stamina);     // 1..5
//   const pw = positionWeight(p.position); // 1..2
//   return r * 10 + s * 2 + pw * 3;
// }

// export async function GET() {
//   const players = await prisma.player.findMany({
//     orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
//     select: {
//       id: true,
//       firstName: true,
//       lastName: true,
//       position: true,
//       isActive: true,
//       rating: true,
//       stamina: true,
//     },
//   });

//   const result = players.map((p) => ({
//     id: p.id,
//     firstName: p.firstName,
//     lastName: p.lastName,
//     position: p.position,
//     isActive: p.isActive,
//     overallScore: overallScore(p),
//   }));

//   return NextResponse.json(result);
// }

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const players = await prisma.player.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      rating: true,
      stamina: true,     // ✅ IMPORTANT
      isActive: true,
    },
  });

  return NextResponse.json(players);
}
