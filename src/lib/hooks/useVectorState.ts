import { useState, useCallback } from 'react';
import type { VectorState } from '../core/types';

/**
 * Default initial state for the vector control
 */
const DEFAULT_STATE: VectorState = {
  collapsed: true,
  panelWidth: 320,
  layers: [],
  data: {},
};

/**
 * Custom hook for managing vector control state in React applications.
 *
 * This hook provides a simple way to track and update the state
 * of a VectorControl from React components.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { state, setState, setCollapsed } = useVectorState();
 *
 *   return (
 *     <div>
 *       <button onClick={() => setCollapsed(!state.collapsed)}>
 *         {state.collapsed ? 'Expand' : 'Collapse'}
 *       </button>
 *       <VectorControlReact
 *         map={map}
 *         collapsed={state.collapsed}
 *         onStateChange={(newState) => setState(newState)}
 *       />
 *     </div>
 *   );
 * }
 * ```
 *
 * @param initialState - Optional initial state values
 * @returns Object containing state and update functions
 */
export function useVectorState(initialState?: Partial<VectorState>) {
  const [state, setState] = useState<VectorState>({
    ...DEFAULT_STATE,
    ...initialState,
  });

  /**
   * Sets the collapsed state
   */
  const setCollapsed = useCallback((collapsed: boolean) => {
    setState((prev) => ({ ...prev, collapsed }));
  }, []);

  /**
   * Sets the panel width
   */
  const setPanelWidth = useCallback((panelWidth: number) => {
    setState((prev) => ({ ...prev, panelWidth }));
  }, []);

  /**
   * Sets custom data in the state
   */
  const setData = useCallback((data: Record<string, unknown>) => {
    setState((prev) => ({ ...prev, data: { ...prev.data, ...data } }));
  }, []);

  /**
   * Resets the state to default values
   */
  const reset = useCallback(() => {
    setState({ ...DEFAULT_STATE, ...initialState });
  }, [initialState]);

  /**
   * Toggles the collapsed state
   */
  const toggle = useCallback(() => {
    setState((prev) => ({ ...prev, collapsed: !prev.collapsed }));
  }, []);

  return {
    state,
    setState,
    setCollapsed,
    setPanelWidth,
    setData,
    reset,
    toggle,
  };
}
