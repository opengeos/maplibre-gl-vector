import { useEffect, useRef } from "react";
import { PluginControl } from "./PluginControl";
import type { PluginControlReactProps } from "./types";

/**
 * React wrapper component for PluginControl.
 *
 * This component manages the lifecycle of a PluginControl instance,
 * adding it to the map on mount and removing it on unmount.
 *
 * @example
 * ```tsx
 * import { PluginControlReact } from 'geolibre-plugin-template/react';
 *
 * function MyMap() {
 *   const [map, setMap] = useState<Map | null>(null);
 *
 *   return (
 *     <>
 *       <div ref={mapContainer} />
 *       {map && (
 *         <PluginControlReact
 *           map={map}
 *           title="My Control"
 *           collapsed={false}
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
export function PluginControlReact({
  map,
  onStateChange,
  ...options
}: PluginControlReactProps): null {
  const controlRef = useRef<PluginControl | null>(null);

  useEffect(() => {
    if (!map) return;

    // Create the control instance
    const control = new PluginControl(options);
    controlRef.current = control;

    // Register state change handler if provided
    if (onStateChange) {
      control.on("statechange", (event) => {
        onStateChange(event.state);
      });
    }

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
