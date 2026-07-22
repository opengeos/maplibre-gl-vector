/**
 * Errors the control throws that a host may want to tell apart from a real
 * failure.
 */

/**
 * Thrown by `addData` when the user dismissed the multi-layer picker without
 * choosing any layer. Nothing was loaded and nothing went wrong, so a host
 * should swallow it rather than surface it as a load failure; the control
 * itself emits no `'error'` event for it.
 */
export class VectorLayerSelectionCancelledError extends Error {
  constructor(message = 'Layer selection cancelled.') {
    super(message);
    this.name = 'VectorLayerSelectionCancelledError';
  }
}

/**
 * Whether a rejection is a dismissed multi-layer picker rather than a load
 * failure. Matches on the error name as well as the class, so a copy that
 * crossed a bundle boundary (two copies of the package, a structured clone)
 * is still recognized.
 *
 * @param error - The value a rejected `addData` produced.
 * @returns True when the load was cancelled by the user.
 */
export function isVectorLayerSelectionCancelled(error: unknown): boolean {
  return (
    error instanceof VectorLayerSelectionCancelledError ||
    (error instanceof Error && error.name === 'VectorLayerSelectionCancelledError')
  );
}
