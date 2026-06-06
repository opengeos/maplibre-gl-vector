// Import styles
import './lib/styles/vector-control.css';

// Main entry point - Core exports
export { VectorControl } from './lib/core/VectorControl';

// Type exports
export type {
  VectorControlOptions,
  VectorState,
  VectorControlEvent,
  VectorControlEventHandler,
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
