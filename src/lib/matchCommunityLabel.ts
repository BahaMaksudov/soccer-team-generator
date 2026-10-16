/**
 * The Community a Match belongs to, as shown next to its venue ("UCCNE - FC
 * (Indoor Soccer) · ForeKicks"). Always the Match's OWN linked Community
 * (Match.communityId) — never inferred from the selected Group or a chat.
 * Channel-neutral: a Community's name is shown the same whether its group
 * chat is on Telegram or (later) WhatsApp.
 */
export const NO_COMMUNITY_LABEL = "No community assigned";

export function matchCommunityLine(communityName: string | null | undefined, locationName: string | null | undefined): { community: string | null; venue: string | null; text: string } {
  const community = communityName?.trim() || null;
  const venue = locationName?.trim() || null;
  return { community, venue, text: [community ?? NO_COMMUNITY_LABEL, venue].filter(Boolean).join(" · ") };
}
