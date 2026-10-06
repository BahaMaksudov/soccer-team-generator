"use client";

import { useState } from "react";
import type { SportClientView } from "@/lib/sports";
import CanonicalSettingsSection from "../CanonicalSettingsSection";
import CanonicalVisibilitySection from "../CanonicalVisibilitySection";
import CommunicationChannelsSection from "../CommunicationChannelsSection";
import TelegramVoterLinks from "./TelegramVoterLinks";

/**
 * UI-8 — group Settings (OWNER/ADMIN; page-level guard + server-side API
 * guards). Hosts the existing settings sections that previously lived only
 * in the Overview's legacy "Players & group settings" workspace.
 */
export default function GroupSettings({
  organizationSlug,
  groupSlug,
  groupName,
  sport,
}: {
  organizationSlug: string;
  groupSlug: string;
  groupName: string;
  sport: SportClientView;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="min-w-0">
        <p className="eyebrow truncate">{groupName}</p>
        <h1 className="mt-1 text-3xl font-extrabold">Group settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Group configuration. Match-day attendance, teams and Telegram posts are handled in each match.</p>
      </header>

      {message && (
        <p role="status" aria-live="polite" className="rounded-tbp border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground">
          {message}
        </p>
      )}

      <section id="general" aria-labelledby="general-heading" className="scroll-mt-20">
        <h2 id="general-heading" className="text-xl font-extrabold">General</h2>
        <CanonicalSettingsSection organizationSlug={organizationSlug} groupSlug={groupSlug} sport={sport} onMessage={setMessage} />
      </section>

      <section id="visibility" aria-labelledby="visibility-heading" className="scroll-mt-20">
        <h2 id="visibility-heading" className="text-xl font-extrabold">Visibility &amp; sharing</h2>
        <CanonicalVisibilitySection organizationSlug={organizationSlug} groupSlug={groupSlug} />
      </section>

      <section id="telegram" aria-labelledby="telegram-heading" className="scroll-mt-20">
        <h2 id="telegram-heading" className="text-xl font-extrabold">Telegram</h2>
        <CommunicationChannelsSection organizationSlug={organizationSlug} groupSlug={groupSlug} />
        <TelegramVoterLinks organizationSlug={organizationSlug} groupSlug={groupSlug} />
      </section>
    </div>
  );
}
