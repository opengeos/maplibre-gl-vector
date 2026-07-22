// Standalone entry point for the control's error helpers, so a host can tell a
// cancelled load apart from a failed one without statically importing the main
// entry (which pulls in VectorControl and, with it, the engine bundle the host
// is deliberately lazy-loading).
export {
  VectorLayerSelectionCancelledError,
  isVectorLayerSelectionCancelled,
} from './lib/core/errors';
