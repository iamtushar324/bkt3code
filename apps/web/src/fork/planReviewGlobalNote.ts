/**
 * T3-CUSTOM(expbkt3): visibility rule for plan review's overall note.
 *
 * The note ships with the decision — it is not chat. Since the docked
 * conversation composer took the bottom of the panel, the note lives in the
 * rail behind a button so an unused box stops eating comment-list height.
 *
 * A button that can hide typed text would be a trap: the reviewer would approve
 * believing their note went along with it. So the rule is asymmetric — the
 * reviewer opens the note, and it stays open for as long as it has content.
 */
export function shouldShowPlanGlobalNote(input: {
  readonly isOpen: boolean;
  readonly note: string;
}): boolean {
  return input.isOpen || input.note.trim().length > 0;
}

/** Whether the reviewer may collapse the note back to its button. */
export function canHidePlanGlobalNote(note: string): boolean {
  return note.trim().length === 0;
}
