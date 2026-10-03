import SiteHeader from "@/components/SiteHeader";

/**
 * UI-1 — the pre-redesign global chrome (soccer background, SiteHeader,
 * centered <main>, footer), moved VERBATIM out of the root layout. Still a
 * SERVER component rendered by RootLayout, so every route except the
 * redesigned marketing homepage server-renders exactly the same markup as
 * before (see src/lib/chrome.ts). Goes away when the app shell replaces it.
 */
export default function LegacyChrome({ teamName, children }: { teamName: string; children: React.ReactNode }) {
  return (
    <>
      <div
        className="fixed inset-0 -z-10 bg-center bg-cover"
        style={{
          backgroundImage: "url('/SoccerTeam.jpg')",
          opacity: 0.85,
        }}
      />

      <div className="fixed inset-0 -z-10 bg-white/70" />

      <SiteHeader teamName={teamName} />

      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>

      <footer className="border-t bg-white/80 mt-12 print:hidden">
        <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
          © {new Date().getFullYear()} Team Balance Pro
        </div>
      </footer>
    </>
  );
}
