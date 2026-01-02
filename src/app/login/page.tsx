import { Suspense } from "react";
import LoginClient from "./LoginClient";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginClient />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="w-full max-w-sm border rounded-xl p-6 bg-white">
        <h1 className="text-xl font-semibold mb-2">Admin Login</h1>
        <div className="text-sm text-gray-600">Loading…</div>
      </div>
    </div>
  );
}
