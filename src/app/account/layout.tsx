import AuthenticatedShell from "@/components/app-shell/AuthenticatedShell";

// UI-3 — authenticated application shell (see src/lib/chrome.ts for the chrome switch).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
