import PersonalAttendancePage from "./PersonalAttendancePage";

/**
 * M12B — a player's personal attendance link (/attend#<token>, website-only
 * matches). The token stays in the URL fragment; the page posts it to
 * /api/attend. No account needed. Never indexed; no Referer.
 */
export const metadata = {
  title: "TeamBalance Pro — Your attendance",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function AttendPage() {
  return <PersonalAttendancePage />;
}
