import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { VectorControl } from "./VectorControl";
import type { VectorControlReactProps } from "./types";

/**
 * Props for the React wrapper, extending the control props with an
 * optional ref exposing the underlying VectorControl instance.
 */
export interface VectorControlReactComponentProps extends VectorControlReactProps {
  /**
   * Ref receiving the VectorControl instance for programmatic use
   * (e.g. `controlRef.current?.addData(url)`)
   */
  controlRef?: Ref<VectorControl | null>;
}

/**
 * React wrapper component for VectorControl.
 *
 * This component manages the lifecycle of a VectorControl instance,
 * adding it to the map on mount and removing it on unmount.
 *
 * @example
 * ```tsx
 * import { VectorControlReact } from 'maplibre-gl-vector/react';
 *
 * function MyMap() {
 *   const [map, setMap] = useState<Map | null>(null);
 *   const controlRef = useRef<VectorControl | null>(null);
 *
 *   return (
 *     <>
 *       <div ref={mapContainer} />
 *       {map && (
 *         <VectorControlReact
 *           map={map}
 *           collapsed={false}
 *           controlRef={controlRef}
 *           onLayerAdded={(layer) => console.log('added', layer.name)}
 *         />
 *       )}
 *     </>
 *   );
 * }
 * ```
 *
 * @param props - Component props including map instance and control options
 * @returns null - This component renders nothing directly
 */
export function VectorControlReact({
  map,
  onStateChange,
  onLayerAdded,
  onLayerRemoved,
  onError,
  controlRef: externalRef,
  ...options
}: VectorControlReactComponentProps): null {
  const controlRef = useRef<VectorControl | null>(null);

  // Hold the latest handler props in refs so the handlers registered on
  // mount never go stale when the parent passes new functions.
  const handlersRef = useRef({ onStateChange, onLayerAdded, onLayerRemoved, onError });
  useEffect(() => {
    handlersRef.current = { onStateChange, onLayerAdded, onLayerRemoved, onError };
  });

  useImperativeHandle<VectorControl | null, VectorControl | null>(
    externalRef,
    () => controlRef.current,
    [map],
  );

  useEffect(() => {
    if (!map) return;

    // Create the control instance
    const control = new VectorControl(options);
    controlRef.current = control;

    // Register event handlers calling through the refs
    control.on("statechange", (event) => {
      handlersRef.current.onStateChange?.(event.state);
    });
    control.on("layeradded", (event) => {
      if (event.layer) handlersRef.current.onLayerAdded?.(event.layer);
    });
    control.on("layerremoved", (event) => {
      if (event.layer) handlersRef.current.onLayerRemoved?.(event.layer);
    });
    control.on("error", (event) => {
      if (event.error) handlersRef.current.onError?.(event.error);
    });

    // Add control to map
    map.addControl(control, options.position || "top-right");

    // Cleanup on unmount
    return () => {
      if (map.hasControl(control)) {
        map.removeControl(control);
      }
      controlRef.current = null;
    };
  }, [map]);

  // Update options when they change
  useEffect(() => {
    if (controlRef.current) {
      // Handle collapsed state changes
      const currentState = controlRef.current.getState();
      if (
        options.collapsed !== undefined &&
        options.collapsed !== currentState.collapsed
      ) {
        if (options.collapsed) {
          controlRef.current.collapse();
        } else {
          controlRef.current.expand();
        }
      }
    }
  }, [options.collapsed]);

  return null;
}
