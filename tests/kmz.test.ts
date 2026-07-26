// @vitest-environment node
// fflate's zipSync checks `instanceof Uint8Array`, which fails under jsdom's
// cross-realm globals (it then mistakes byte values for nested directories).
// This helper is DOM-free, so run it in the node environment where the zip
// round-trip behaves as it does in a real (single-realm) browser.
import { describe, expect, it } from 'vitest';
import { strToU8, strFromU8, zipSync } from 'fflate';
import { extractKmzKml, pickKmlEntry } from '../src/lib/formats/kmz';

const KML = '<?xml version="1.0"?><kml><Document></Document></kml>';

describe('pickKmlEntry', () => {
  it('prefers doc.kml over other KML entries', () => {
    expect(pickKmlEntry(['aaa.kml', 'doc.kml', 'zzz.kml'])).toBe('doc.kml');
  });

  it('prefers a nested doc.kml too', () => {
    expect(pickKmlEntry(['files/other.kml', 'files/doc.kml'])).toBe('files/doc.kml');
  });

  it('falls back to the first KML when there is no doc.kml', () => {
    // NASA FIRMS ships a single timestamped name, not doc.kml.
    expect(pickKmlEntry(['images/icon.png', 'MODIS_C61_Russia_Asia_24h_178.kml'])).toBe(
      'MODIS_C61_Russia_Asia_24h_178.kml',
    );
  });

  it('picks deterministically when several KMLs share an archive', () => {
    expect(pickKmlEntry(['b.kml', 'a.kml'])).toBe('a.kml');
    expect(pickKmlEntry(['a.kml', 'b.kml'])).toBe('a.kml');
  });

  it('ignores macOS archive metadata', () => {
    // An AppleDouble shadow is a few hundred bytes of resource fork, which
    // GDAL rejects; it must never be mistaken for the real document.
    expect(pickKmlEntry(['__MACOSX/._doc.kml', '._doc.kml', 'real.kml'])).toBe('real.kml');
  });

  it('matches the extension case-insensitively', () => {
    expect(pickKmlEntry(['Overlay.KML'])).toBe('Overlay.KML');
  });

  it('returns undefined when the archive holds no KML', () => {
    expect(pickKmlEntry(['images/icon.png', 'model.dae'])).toBeUndefined();
  });
});

describe('extractKmzKml', () => {
  it('returns the KML document inside a KMZ', () => {
    const kmz = zipSync({ 'doc.kml': strToU8(KML), 'files/icon.png': new Uint8Array([1, 2]) });
    const entry = extractKmzKml(kmz);
    expect(entry.entryName).toBe('doc.kml');
    expect(strFromU8(entry.bytes)).toBe(KML);
  });

  it('reads an archive whose KML is not named doc.kml', () => {
    const kmz = zipSync({ 'MODIS_C61_Russia_Asia_24h_178.kml': strToU8(KML) });
    expect(strFromU8(extractKmzKml(kmz).bytes)).toBe(KML);
  });

  it('throws an actionable error when the archive holds no KML', () => {
    const kmz = zipSync({ 'files/icon.png': new Uint8Array([1, 2]) });
    expect(() => extractKmzKml(kmz)).toThrow(/does not contain a \.kml file/i);
  });

  it('reports a corrupt archive rather than surfacing the raw unzip error', () => {
    // What a truncated download or an HTML error page served as .kmz looks like.
    expect(() => extractKmzKml(strToU8('<html>404</html>'))).toThrow(
      /could not be unzipped/i,
    );
  });
});
