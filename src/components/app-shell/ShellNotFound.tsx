import Link from "next/link";

/**
 * UI-3 — 404 inside the app shell (admin/me/account segments). One message
 * for "doesn't exist" and "not yours": it never reveals whether a tenant exists.
 */
export default function ShellNotFound() {
  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-3xl font-extrabold">Page not found</h1>
      <p className="mt-3 text-muted-foreground">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/admin" className="mt-6 inline-flex h-10 items-center justify-center rounded-tbp-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        Go to your workspaces
      </Link>
    </div>
  );
}
