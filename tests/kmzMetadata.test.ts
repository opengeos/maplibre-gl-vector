// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { enhanceKmzGeoJSON } from '../src/lib/formats/kmzMetadata';

describe('enhanceKmzGeoJSON', () => {
  it('restores formatted descriptions and embedded placemark icons', async () => {
    // Pre-built in one Node realm: constructing a fflate zip in jsdom mixes
    // Uint8Array realms and makes fflate mistake byte arrays for directories.
    const archive = Uint8Array.from(
      atob(
        'UEsDBBQAAAAIAAee/lzXRWjs9AAAAI8BAAAHAAAAZG9jLmttbFVQwU7DMAz9lVGuqGaVuCDXU0Uv3CYBp2mHkIY1WppESaDs73HSAdshes/PT8+OcfM9mdWXClE721br+r7aEB5ZY93GthpT8o8A8zzXzit70LG2KgE7oKmbirB38nNSNhFujZBqEuFIaMWkqDN+FAiF46CiDNonHkN4s3vqu9duh0m8G26mwG+gXiSFwCQXyQ3itFSQ+7B493umV2ExnYx6C4ZutXQW4a/GrdN5L+lcGLTl8EjruwbhUkA4u+Bi/ZccsdJDW+VI/uQzQxF5nBQM6/qBJxVamoRjUB+U7RG8trW3B4SiISyGAucQ+MX/6+WT0g9QSwMEFAAAAAgAB57+XKW+61sGAAAABAAAAA0AAABpY29ucy9waW4ucG5n6wzwcwcAUEsBAhQAFAAAAAgAB57+XNdFaOz0AAAAjwEAAAcAAAAAAAAAAAAAAAAAAAAAAGRvYy5rbWxQSwECFAAUAAAACAAHnv5cpb7rWwYAAAAEAAAADQAAAAAAAAAAAAAAAAAZAQAAaWNvbnMvcGluLnBuZ1BLBQYAAAAAAgACAHAAAABKAQAAAAA=',
      ),
      (character) => character.charCodeAt(0),
    );
    const file = {
      name: 'sample.kmz',
      arrayBuffer: async () =>
        archive.buffer.slice(
          archive.byteOffset,
          archive.byteOffset + archive.byteLength,
        ) as ArrayBuffer,
    };
    const collection = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [1, 2] },
          properties: { Name: 'Alpha' },
        },
      ],
    };

    await enhanceKmzGeoJSON(file, collection);

    expect(collection.features[0].properties).toMatchObject({
      name: 'Alpha',
      description: '<table><tr><td>Date</td><td>today</td></tr></table>',
      __geolibre_kml_icon_scale: 1.5,
    });
    expect(collection.features[0].properties.__geolibre_kml_icon_url).toMatch(
      /^data:image\/png;base64,/,
    );
  });
});
