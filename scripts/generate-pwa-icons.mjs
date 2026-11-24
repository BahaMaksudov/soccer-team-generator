// Generates the PWA / home-screen icons from the EXISTING brand artwork
// (public/branding/teambalancefavicon.png) — the same mark, re-laid out, never redrawn:
//   - maskable-192/512.png: full-bleed tile color, mark inside the maskable safe zone
//     (Android launchers crop to circles / squircles);
//   - apple-touch-icon.png (180): full-bleed tile, so iOS's own rounding doesn't show the
//     artwork's baked-in tile, shadow and white margin as a "tile inside a tile".
// The existing "any" icons (icon-192/512.png) and favicons are unchanged.
// Run: node scripts/generate-pwa-icons.mjs   (uses sharp, already installed with Next.js)
import sharp from "sharp";

const SRC = "public/branding/teambalancefavicon.png";
// The logo mark's bounding box inside the source tile (measured: x 156–1091, y 277–1038) + margin.
// Every corner of this box lies on the tile's flat off-white area (inside its rounded corners).
const MARK = { left: 146, top: 267, width: 956, height: 782 };

/**
 * The mark as RGBA: the source tile behind it has a slight top-to-bottom gradient, so each pixel's
 * background is estimated from the crop's top/bottom rows (linear in y) and removed (alpha =
 * distance from that background; color un-mixed). Composited onto one flat tile color, there is
 * no visible seam. Returns the mark and the flat color (the crop border's average).
 */
async function extractMark() {
  const { data, info } = await sharp(SRC).extract(MARK).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const rowAvg = (y) => {
    const s = [0, 0, 0];
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) s[k] += data[(y * w + x) * c + k];
    return s.map((v) => v / w);
  };
  const top = rowAvg(0), bottom = rowAvg(h - 1);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const bg = [0, 1, 2].map((k) => top[k] + (bottom[k] - top[k]) * t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c, o = (y * w + x) * 4;
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(data[i + k] - bg[k])));
      const a = Math.min(1, Math.max(0, (d - 4) / 36));
      for (let k = 0; k < 3; k++) out[o + k] = a > 0 ? Math.round(Math.min(255, Math.max(0, (data[i + k] - (1 - a) * bg[k]) / a))) : 0;
      out[o + 3] = Math.round(a * 255);
    }
  }
  const flat = [0, 1, 2].map((k) => Math.round((top[k] + bottom[k]) / 2));
  return { mark: await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), bg: { r: flat[0], g: flat[1], b: flat[2] } };
}

async function icon({ mark, bg }, size, markWidthRatio, out) {
  const markWidth = Math.round(size * markWidthRatio);
  const scaled = await sharp(mark).resize({ width: markWidth, kernel: "lanczos3" }).png().toBuffer();
  const { height } = await sharp(scaled).metadata();
  await sharp({ create: { width: size, height: size, channels: 3, background: bg } })
    .composite([{ input: scaled, left: Math.round((size - markWidth) / 2), top: Math.round((size - height) / 2) }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`${out} ${size}x${size} (mark ${markWidth}px wide)`);
}

const art = await extractMark();
console.log("tile color", `#${[art.bg.r, art.bg.g, art.bg.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
// Maskable: the mark's bounding box diagonal stays inside the 80% safe-zone circle.
await icon(art, 192, 0.62, "public/icons/maskable-192.png");
await icon(art, 512, 0.62, "public/icons/maskable-512.png");
// Apple: iOS rounds the corners itself and doesn't crop to a circle — a larger mark reads better.
await icon(art, 180, 0.78, "public/icons/apple-touch-icon.png");
