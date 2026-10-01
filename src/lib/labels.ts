/**
 * Soccer position labels (pre-M7). M7: Groups of any sport render role
 * labels via roleLabel(sportKey, key) in src/lib/sports — this remains
 * only for legacy soccer-only code paths.
 */
export function positionLabel(pos: string) {
  switch (pos) {
    case "GOALKEEPER": return "Goalkeeper";
    case "DEFENDER": return "Defender";
    case "MIDFIELDER": return "Midfielder";
    case "FORWARD": return "Forward";
    default: return pos;
  }
}
export function ratingLabel(r: string) {
  switch (r) {
    case "FAIR": return "Fair";
    case "GOOD": return "Good";
    case "VERY_GOOD": return "Very Good";
    case "EXCELLENT": return "Excellent";
    default: return r;
  }
}
