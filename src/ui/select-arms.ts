/**
 * Which candidates may be sent with a given baseline.
 *
 * Switching the baseline must drop it from the candidate list: the checkbox
 * list on screen hides the baseline, so a stale entry would travel invisibly
 * with the request and the run would be refused for naming the same arm twice.
 * When nothing is left, fall back to the first other arm so the form stays
 * runnable; with only one arm defined there is nothing to compare and the
 * caller must keep the Start button disabled.
 */
export function pickCandidates(candidates: string[], baseline: string, armNames: string[]): string[] {
  const kept = candidates.filter(n => n !== baseline && armNames.includes(n))
  if (kept.length > 0) return kept
  const fallback = armNames.find(n => n !== baseline)
  return fallback === undefined ? [] : [fallback]
}
