"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
type Weights = {
 staminaCoef: number;
 positionWeights: Record<string, number>;
 fairnessWeights: Record<string, number>;
 optimizer: { iterations: number; samePositionSwapBias: number };
};
export default function AdminSettingsPage() {
 const [weights, setWeights] = useState<Weights | null>(null);
 const [saving, setSaving] = useState(false);
 const [msg, setMsg] = useState<string | null>(null);
 useEffect(() => {
   fetch("/api/admin/settings/balance-weights", { cache: "no-store" })
     .then((r) => r.json())
     .then((d) => setWeights(d.weights))
     .catch(() => setMsg("Failed to load settings."));
 }, []);
 function setPW(key: string, value: number) {
   setWeights((w) => (w ? { ...w, positionWeights: { ...w.positionWeights, [key]: value } } : w));
 }
 function setFW(key: string, value: number) {
   setWeights((w) => (w ? { ...w, fairnessWeights: { ...w.fairnessWeights, [key]: value } } : w));
 }
 async function save() {
   if (!weights) return;
   setSaving(true);
   setMsg(null);
   const res = await fetch("/api/admin/settings/balance-weights", {
     method: "PUT",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ weights }),
   });
   const data = await res.json().catch(() => ({}));
   setSaving(false);
   if (!res.ok) {
     setMsg(data?.error ?? "Failed to save settings.");
     return;
   }
   setMsg("✅ Settings saved.");
 }
 if (!weights) return <div className="p-4">Loading settings…</div>;
 return (
<div className="space-y-6">
<div className="flex items-center gap-3">
<h1 className="text-2xl font-semibold">Admin Settings</h1>
<Link className="ml-auto text-sm underline" href="/admin">
         Back to Admin
</Link>
</div>
     {msg && <div className="text-sm text-blue-700">{msg}</div>}
<div className="rounded-2xl border bg-white p-5 shadow-sm space-y-6">
       {/* Stamina */}
<div>
<div className="font-semibold text-slate-900">Impact Formula</div>
<div className="text-xs text-slate-500 mt-1">
           playerImpact = ratingWeight + staminaCoef × stamina, then multiplied by positionWeight.
</div>
<label className="block text-sm font-medium text-slate-700 mt-3 mb-1">Stamina coefficient</label>
<input
           type="number"
           step="0.1"
           className="border rounded-lg px-3 py-2 w-full max-w-xs"
           value={weights.staminaCoef}
           onChange={(e) => setWeights({ ...weights, staminaCoef: Number(e.target.value) })}
         />
</div>
       {/* Position weights */}
<div>
<div className="font-semibold text-slate-900">Role weights by position</div>
<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
           {["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"].map((k) => (
<div key={k}>
<label className="block text-sm font-medium text-slate-700 mb-1">{k}</label>
<input
                 type="number"
                 step="0.05"
                 className="border rounded-lg px-3 py-2 w-full"
                 value={weights.positionWeights[k] ?? 1}
                 onChange={(e) => setPW(k, Number(e.target.value))}
               />
</div>
           ))}
</div>
</div>
       {/* Fairness weights */}
<div>
<div className="font-semibold text-slate-900">Fairness weights</div>
<div className="text-xs text-slate-500 mt-1">
           Higher value = generator tries harder to equalize that category across teams.
</div>
<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
           {[
             ["totalImpact", "Total impact"],
             ["gkImpact", "GK impact"],
             ["defImpact", "DEF impact"],
             ["midImpact", "MID impact"],
             ["fwdImpact", "FWD impact"],
             ["topCount", "Top-player count (EXCELLENT)"],
           ].map(([key, label]) => (
<div key={key}>
<label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
<input
                 type="number"
                 step="0.5"
                 className="border rounded-lg px-3 py-2 w-full"
                 value={(weights.fairnessWeights as any)[key] ?? 0}
                 onChange={(e) => setFW(key, Number(e.target.value))}
               />
</div>
           ))}
</div>
</div>
       {/* Optimizer */}
<div>
<div className="font-semibold text-slate-900">Optimizer</div>
<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
<div>
<label className="block text-sm font-medium text-slate-700 mb-1">Iterations</label>
<input
               type="number"
               min={0}
               step="50"
               className="border rounded-lg px-3 py-2 w-full"
               value={weights.optimizer.iterations}
               onChange={(e) =>
                 setWeights({ ...weights, optimizer: { ...weights.optimizer, iterations: Number(e.target.value) } })
               }
             />
</div>
<div>
<label className="block text-sm font-medium text-slate-700 mb-1">Same-position swap bias</label>
<input
               type="number"
               min={0}
               max={1}
               step="0.05"
               className="border rounded-lg px-3 py-2 w-full"
               value={weights.optimizer.samePositionSwapBias}
               onChange={(e) =>
                 setWeights({
                   ...weights,
                   optimizer: { ...weights.optimizer, samePositionSwapBias: Number(e.target.value) },
                 })
               }
             />
</div>
</div>
</div>
<button
         className={`rounded-lg py-2 px-4 font-semibold text-white transition ${
           saving ? "bg-slate-400" : "bg-emerald-600 hover:bg-emerald-700"
         }`}
         disabled={saving}
         onClick={save}
>
         {saving ? "Saving…" : "Save Settings"}
</button>
</div>
</div>
 );
}