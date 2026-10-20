import JoinGroupPage from "./JoinGroupPage";

/**
 * M13A — group invitation landing (/join#<token>). The token stays in the URL
 * fragment; the page posts it to /api/join. Sign-in returns here WITHOUT the
 * token in any URL (the page keeps it briefly in this browser). Never indexed;
 * no Referer.
 */
export const metadata = {
  title: "Team Balance Pro — Join a group",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function JoinPage() {
  return <JoinGroupPage />;
}
