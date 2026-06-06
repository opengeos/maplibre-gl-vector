import { PluginControl } from "./lib/core/PluginControl";
import type { PluginState } from "./lib/core/types";
import "./lib/styles/plugin-control.css";

type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

interface GeoLibreAppAPI {
  addMapControl: (
    control: PluginControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  removeMapControl: (control: PluginControl) => void;
}

interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  setMapControlPosition?: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}

let control: PluginControl | null = null;
let position: GeoLibreMapControlPosition = "top-right";
let pendingState: Partial<PluginState> | null = null;

function createControl(): PluginControl {
  const nextControl = new PluginControl({
    collapsed: pendingState?.collapsed ?? true,
    panelWidth: pendingState?.panelWidth ?? 300,
    title: "GeoLibre Plugin Template",
  });

  if (pendingState) {
    nextControl.setState(pendingState);
  }

  return nextControl;
}

function isPluginState(value: unknown): value is Partial<PluginState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if ("collapsed" in candidate && typeof candidate.collapsed !== "boolean") {
    return false;
  }
  if ("panelWidth" in candidate && typeof candidate.panelWidth !== "number") {
    return false;
  }
  if (
    "data" in candidate &&
    (typeof candidate.data !== "object" ||
      candidate.data === null ||
      Array.isArray(candidate.data))
  ) {
    return false;
  }

  return true;
}

export const plugin: GeoLibrePlugin = {
  id: "geolibre-plugin-template",
  name: "GeoLibre Plugin Template",
  version: "0.1.0",
  activate(app) {
    control = control ?? createControl();
    const added = app.addMapControl(control, position);
    if (!added) {
      control = null;
      return false;
    }
  },
  deactivate(app) {
    if (!control) return;
    pendingState = control.getState();
    app.removeMapControl(control);
    control = null;
  },
  getMapControlPosition() {
    return position;
  },
  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    if (!control) return;

    app.removeMapControl(control);
    const added = app.addMapControl(control, position);
    if (!added) {
      pendingState = control.getState();
      control = null;
      return false;
    }
  },
  getProjectState() {
    return control?.getState() ?? pendingState ?? undefined;
  },
  applyProjectState(_app, state) {
    if (!isPluginState(state)) return false;
    pendingState = state;
    control?.setState(state);
  },
};

export default plugin;
