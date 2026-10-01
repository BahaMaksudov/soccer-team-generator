"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function InviteForm({ organizationSlug, roles }: { organizationSlug: string; roles: string[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(roles[roles.length - 1] ?? "MEMBER");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setMsg(null);
    setLink(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/o/${encodeURIComponent(organizationSlug)}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const field = data?.issues?.fieldErrors && Object.values(data.issues.fieldErrors as Record<string, string[]>).flat()[0];
        setMsg({ kind: "err", text: field || data?.error || "Could not create the invitation." });
      } else {
        setMsg({
          kind: "ok",
          text: data.invitePath
            ? `Invitation emailed to ${data.invitation?.email ?? "the recipient"}. Development link:`
            : `Invitation emailed to ${data.invitation?.email ?? "the recipient"}.`,
        });
        if (typeof data.invitePath === "string") setLink(`${window.location.origin}${data.invitePath}`);
        setEmail("");
        router.refresh();
      }
    } catch {
      setMsg({ kind: "err", text: "Could not create the invitation." });
    }
    setLoading(false);
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input type="email" className="flex-1 min-w-[12rem] border rounded-md px-3 py-2" placeholder="name@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
        <select className="border rounded-md px-3 py-2 bg-white" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          {roles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="submit" className="bg-black text-white rounded-md px-4 py-2 disabled:opacity-60" disabled={loading}>
          {loading ? "Inviting..." : "Invite"}
        </button>
      </div>
      {msg && <div className={`text-sm ${msg.kind === "ok" ? "text-green-700" : "text-red-600"}`}>{msg.text}</div>}
      {link && <code className="block text-xs break-all bg-gray-50 border rounded p-2">{link}</code>}
    </form>
  );
}
