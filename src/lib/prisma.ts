import { PrismaClient } from "@prisma/client";
import { assertLocalSafeDatabaseUrl } from "@/lib/databaseGuard";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Local dev / test processes never reach a hosted (Neon / Production) database by accident.
assertLocalSafeDatabaseUrl();

export const prisma: PrismaClient = global.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") global.prisma = prisma;
