// Import styles
import './lib/styles/plugin-control.css';

// Main entry point - Core exports
export { PluginControl } from './lib/core/PluginControl';

// Type exports
export type {
  PluginControlOptions,
  PluginState,
  PluginControlEvent,
  PluginControlEventHandler,
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
