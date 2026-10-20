import { NextResponse } from "next/server";

/**
 * M12B — the shared Match Link is VIEW-ONLY for attendance. Anonymous answering
 * (pick a name, answer for that Player) is no longer accepted: anyone holding the
 * link could change anyone's attendance. Players answer in the Match's Telegram
 * poll, or through their own personal attendance link (/attend). Enforced here,
 * not only in the page. Nothing is read or written.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function POST() {
  return NextResponse.json(
    { error: "Attendance can't be changed through the shared match link. Vote in your group's Telegram poll, or use the personal link your organizer sent you.", code: "MATCH_LINK_READ_ONLY" },
    { status: 410, headers: HEADERS }
  );
}
