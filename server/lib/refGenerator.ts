/**
 * Generate a personal reference like DP-20260422-A7K9 when the user leaves it blank.
 * Format: DP-<YYYYMMDD>-<4 chars from a no-ambiguity alphabet>
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I for readability

export function generatePersonalRef(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `DP-${yyyy}${mm}${dd}-${suffix}`;
}
