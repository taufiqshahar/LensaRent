/**
 * Content that is not yet confirmed by the owner (specs, kit list, business details,
 * legal text) is wrapped in `draft()`. A production build fails while any draft remains;
 * staging builds show a visible "DRAF" banner instead. Guessed content can never ship.
 */
const drafts = new Set<string>();

export function draft<T>(label: string, value: T): T {
  drafts.add(label);
  return value;
}

export function collectedDrafts(): string[] {
  return [...drafts].sort();
}

export function resetDrafts(): void {
  drafts.clear();
}
