import { z } from "zod";
import { Position, Rating } from "@prisma/client";

/**
 * Shared request-validation schemas for admin/mutating API routes.
 *
 * Deliberately NOT used to validate the Telegram webhook payload body —
 * Telegram's update shape is externally controlled and only loosely
 * documented; over-strict validation there risks silently dropping
 * legitimate updates. The webhook route keeps its existing tolerant,
 * defensive parsing instead.
 */

export const positionSchema = z.nativeEnum(Position);
export const ratingSchema = z.nativeEnum(Rating);

const staminaSchema = z.coerce.number().min(1).max(5);

export const playerCreateSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required."),
  lastName: z.string().trim().min(1, "Last name is required."),
  position: positionSchema,
  rating: ratingSchema,
  stamina: staminaSchema.optional(),
  isActive: z.boolean().optional(),
});

export const playerUpdateSchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  position: positionSchema.optional(),
  rating: ratingSchema.optional(),
  stamina: staminaSchema.optional(),
  isActive: z.boolean().optional(),
});

export const generateTeamsSchema = z.object({
  teamCount: z.coerce.number().int().min(2),
  date: z.string().trim().min(1, "Date is required."),
  selectedIds: z.array(z.string().min(1)).min(1, "Select at least one player."),
  format: z.union([z.literal(6), z.literal(7), z.literal(8)]).optional(),
});

// .passthrough() is required on both levels: teamsJson is stored as the
// full, as-given team objects (id, position, etc. beyond firstName/
// lastName), and Zod strips unknown keys from a plain z.object() by
// default — without passthrough(), publishing would silently corrupt
// stored teams by dropping every field this schema doesn't name.
const publishPlayerSchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  })
  .passthrough();

const publishTeamSchema = z
  .object({
    teamNumber: z.number(),
    players: z.array(publishPlayerSchema),
  })
  .passthrough();

export const publishTeamsSchema = z.object({
  date: z.string().trim().min(1, "Date is required."),
  teams: z.array(publishTeamSchema).min(1, "Teams are required."),
  pollId: z.string().trim().optional().default(""),
  closePoll: z.boolean().optional(),
  postToTelegram: z.boolean().optional(),
});

export const teamNameSchema = z.object({
  teamName: z.string().trim().min(1, "Team name is required.").max(80, "Team name too long (max 80 chars)."),
});

export const positionWeightsSchema = z
  .object({
    GOALKEEPER: z.coerce.number().optional(),
    DEFENDER: z.coerce.number().optional(),
    MIDFIELDER: z.coerce.number().optional(),
    FORWARD: z.coerce.number().optional(),
  })
  .partial();

export const balanceWeightsSchema = z.object({
  staminaCoef: z.coerce.number().optional(),
  positionWeights: positionWeightsSchema.optional(),
});

export const telegramCreatePollSchema = z.object({
  chatId: z.string().trim().min(1, "chatId is required"),
  pollDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "pollDate is required (YYYY-MM-DD)"),
  question: z.string().trim().optional(),
});

export const telegramLinkSchema = z.object({
  userId: z.string().trim().min(1, "userId is required"),
  playerId: z.string().trim().min(1, "playerId is required"),
});

export const telegramImportSchema = z.object({
  pollId: z.string().trim().min(1, "pollId is required"),
});

/**
 * Formats a ZodError into a small, safe JSON-serializable shape —
 * never leaks stack traces or internal details.
 */
export function zodErrorResponse(error: z.ZodError) {
  return { error: "Invalid request.", issues: error.flatten() };
}
