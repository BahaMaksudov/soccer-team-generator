import AuthenticatedShell from "@/components/app-shell/AuthenticatedShell";

// UI-7 — first-run onboarding inside the authenticated application shell.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
