// Import styles
import './lib/styles/vector-control.css';

// Main entry point - Core exports
export { VectorControl } from './lib/core/VectorControl';
export { DEFAULT_STYLE } from './lib/render/styleBuilder';
export { DEFAULT_AUTO_THRESHOLD } from './lib/render/renderMode';

// Type exports
export type {
  AutoThreshold,
  GeometryCategory,
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorControlOptions,
  VectorDataSource,
  VectorEventPayload,
  VectorFormat,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
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
