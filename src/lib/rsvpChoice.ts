/**
 * M13B P5 — the Yes / Maybe / No buttons of an RSVP email open the personal attendance
 * page with `?c=yes|maybe|no`. That only PRE-SELECTS an answer on the page; nothing is
 * saved until the recipient taps Confirm (email scanners and link previews open links
 * but never confirm). Anything unrecognized is ignored.
 */
export type AttendanceChoice = "PLAYING" | "MAYBE" | "NOT_PLAYING";
const CHOICES: Record<string, AttendanceChoice> = { yes: "PLAYING", maybe: "MAYBE", no: "NOT_PLAYING" };

export function choiceFromSearch(search: string): AttendanceChoice | null {
  const c = new URLSearchParams(search).get("c");
  return c && Object.prototype.hasOwnProperty.call(CHOICES, c) ? CHOICES[c] : null;
}
