import AppShell from "./AppShell";
import { loadShellData } from "@/lib/appShellData";

/**
 * UI-3 — layout wrapper for the authenticated routes that use the new shell
 * (/admin/**, /me, /account/**). Without a resolvable session account the
 * page renders alone, so each page's own auth handling (redirect to /login,
 * /verify-email, 404…) is exactly as before; the shell never grants access.
 */
export default async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const data = await loadShellData();
  if (!data) return <>{children}</>;
  return <AppShell data={data}>{children}</AppShell>;
}
