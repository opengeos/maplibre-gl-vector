import { describe, it, expect } from 'vitest';
import { VectorControl } from '../src/lib/core/VectorControl';

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

/** A control docked inside `className`, with only the fields corner detection reads. */
function dockedIn(className: string): { _getControlPosition: () => string } {
  const parent = document.createElement('div');
  parent.className = className;
  const container = document.createElement('div');
  parent.appendChild(container);
  return Object.assign(Object.create(VectorControl.prototype), {
    _container: container,
  });
}

describe('VectorControl corner detection', () => {
  // Both engines dock a control in a corner div, but name it with their own
  // prefix. Reading only the MapLibre class would fall back to top-right on
  // mapbox-gl and drop the panel on top of whatever else sits there.
  for (const engine of ['maplibregl', 'mapboxgl']) {
    for (const corner of CORNERS) {
      it(`reads the ${engine}-ctrl-${corner} corner`, () => {
        expect(dockedIn(`${engine}-ctrl-${corner}`)._getControlPosition()).toBe(corner);
      });
    }
  }

  it('falls back to top-right without a recognised corner', () => {
    expect(dockedIn('some-other-ctrl-bottom-left')._getControlPosition()).toBe('top-right');

    const detached = Object.assign(Object.create(VectorControl.prototype), {
      _container: document.createElement('div'),
    }) as { _getControlPosition: () => string };
    expect(detached._getControlPosition()).toBe('top-right');
  });
});
