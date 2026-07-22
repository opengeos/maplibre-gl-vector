// Import styles
import './lib/styles/vector-control.css';

// Main entry point - Core exports
export { VectorControl } from './lib/core/VectorControl';
export {
  VectorLayerSelectionCancelledError,
  isVectorLayerSelectionCancelled,
} from './lib/core/errors';
export { DEFAULT_STYLE } from './lib/render/styleBuilder';
export { DEFAULT_AUTO_THRESHOLD } from './lib/render/renderMode';

// Type exports
export type {
  AutoThreshold,
  GeometryCategory,
  PointMode,
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorControlOptions,
  VectorDataSource,
  VectorEventPayload,
  VectorFileOpener,
  VectorFileSelection,
  VectorFormat,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerSelectionContext,
  VectorLayerSelector,
  VectorLayerStyle,
  VectorSampleDataset,
  VectorSourceDescriptor,
  VectorState,
} from './lib/core/types';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';
