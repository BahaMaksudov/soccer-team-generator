import UnsubscribeView from "./UnsubscribeView";

/**
 * M13B P3 — RSVP email unsubscribe (/unsubscribe#<token>). The token stays in the URL
 * fragment; the page posts it. Opening the page never unsubscribes anyone — only the
 * explicit button does. Never indexed; no Referer.
 */
export const metadata = {
  title: "Unsubscribe — TeamBalance Pro",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function UnsubscribePage() {
  return <UnsubscribeView />;
}
