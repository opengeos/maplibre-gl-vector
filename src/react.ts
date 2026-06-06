// React entry point
export { PluginControlReact } from './lib/core/PluginControlReact';

// React hooks
export { usePluginState } from './lib/hooks';

// Re-export types for React consumers
export type {
  PluginControlOptions,
  PluginState,
  PluginControlReactProps,
  PluginControlEvent,
  PluginControlEventHandler,
} from './lib/core/types';
