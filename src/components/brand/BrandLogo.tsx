import Image from "next/image";
import headerLogo from "../../../public/branding/TeamBalanceProHeaderLogo.png";
import brandMark from "../../../public/icons/icon-192.png";
import { cn } from "@/lib/cn";

/**
 * Brand assets (aspect ratios preserved, never distorted):
 *  - BrandLogo: the horizontal TeamBalance Pro header logo
 *    (public/branding/TeamBalanceProHeaderLogo.png, 2089×511, transparent background —
 *    the supplied "TeamBalance Pro Fitness Logo.png" with only its empty transparent margin
 *    trimmed). Sized so the lettering stays legible (36–40 px tall). Its dark lettering needs
 *    a light surface, so `onDark` places it on a light rounded backing.
 *    The banner public/branding/TeamBalanceProMainLogo.png is kept for promotional use.
 *  - BrandMark: the square brand icon (generated from public/branding/teambalancefavicon.png)
 *    for headers too narrow for the full logo (e.g. the app's mobile header).
 * Width/height are given explicitly so the space is reserved (no layout shift).
 */
export function BrandLogo({ className, priority = false, onDark = false }: { className?: string; priority?: boolean; onDark?: boolean }) {
  const img = (
    <Image
      src={headerLogo}
      width={2089}
      height={511}
      alt="TeamBalance Pro"
      priority={priority}
      sizes="(min-width: 640px) 164px, 148px"
      className={cn("h-9 w-auto sm:h-10", className)}
    />
  );
  return onDark ? <span className="inline-flex items-center rounded-tbp-md bg-white px-2.5 py-1.5 shadow-sm">{img}</span> : img;
}

export function BrandMark({ className }: { className?: string }) {
  return <Image src={brandMark} width={192} height={192} alt="" sizes="40px" className={cn("size-8 rounded-tbp-sm", className)} />;
}
