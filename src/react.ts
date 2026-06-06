// React entry point
export { VectorControlReact } from './lib/core/VectorControlReact';

// React hooks
export { useVectorState } from './lib/hooks';

// Re-export types for React consumers
export type {
  VectorControlOptions,
  VectorState,
  VectorControlReactProps,
  VectorControlEvent,
  VectorControlEventHandler,
} from './lib/core/types';
