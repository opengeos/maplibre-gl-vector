// React entry point
export { VectorControlReact } from './lib/core/VectorControlReact';
export type { VectorControlReactComponentProps } from './lib/core/VectorControlReact';

// React hooks
export { useVectorState } from './lib/hooks';

// Re-export types for React consumers
export type {
  AutoThreshold,
  GeometryCategory,
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorControlOptions,
  VectorControlReactProps,
  VectorDataSource,
  VectorEventPayload,
  VectorFormat,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
  VectorState,
} from './lib/core/types';
