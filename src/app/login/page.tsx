import { Suspense } from "react";
import AuthLayout from "@/components/auth/AuthLayout";
import { FormHead, InfoNote } from "@/components/auth/parts";
import { isGoogleAuthConfigured } from "@/lib/googleAuth";
import LoginClient from "./LoginClient";

export const metadata = {
  title: "Sign In — Team Balance Pro",
  description: "Sign in to manage your groups, matches, players, and teams.",
};

export default function LoginPage() {
  return (
    <AuthLayout headline="Welcome back to game day." body="Sign in to manage your groups, matches, players, and teams.">
      <FormHead title="Sign in" body="Welcome back to Team Balance Pro." />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <LoginClient googleEnabled={isGoogleAuthConfigured()} />
      </Suspense>
      <InfoNote title="Just here for your game?">
        Players can view shared teams and match information without creating an account when their organizer sends them a match link.
      </InfoNote>
    </AuthLayout>
  );
}
