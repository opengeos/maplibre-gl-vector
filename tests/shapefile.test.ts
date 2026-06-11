// @vitest-environment node
// fflate's zipSync checks `instanceof Uint8Array`, which fails under jsdom's
// cross-realm globals (it then mistakes byte values for nested directories).
// This helper is DOM-free, so run it in the node environment where the zip
// round-trip behaves as it does in a real (single-realm) browser.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { registerZippedShapefile } from '../src/lib/formats/shapefile';

function recorder() {
  const registered = new Map<string, Uint8Array>();
  return {
    registered,
    register: (name: string, bytes: Uint8Array) => {
      registered.set(name, bytes);
    },
  };
}

describe('registerZippedShapefile', () => {
  it('registers every component under the base name and returns the .shp path', async () => {
    const zip = zipSync({
      'states.shp': strToU8('shp'),
      'states.dbf': strToU8('dbf'),
      'states.shx': strToU8('shx'),
      'states.prj': strToU8('prj'),
      'states.cpg': strToU8('cpg'),
    });
    const { registered, register } = recorder();

    const shpPath = await registerZippedShapefile(zip, 't_vector_1', register);

    expect(shpPath).toBe('t_vector_1.shp');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_1.cpg',
      't_vector_1.dbf',
      't_vector_1.prj',
      't_vector_1.shp',
      't_vector_1.shx',
    ]);
    expect(registered.get('t_vector_1.dbf')).toEqual(strToU8('dbf'));
  });

  it('handles a shapefile nested in a subdirectory and ignores unrelated files', async () => {
    const zip = zipSync({
      'data/roads.shp': strToU8('shp'),
      'data/roads.dbf': strToU8('dbf'),
      'data/roads.shx': strToU8('shx'),
      'data/readme.txt': strToU8('hi'),
    });
    const { registered, register } = recorder();

    const shpPath = await registerZippedShapefile(zip, 't_vector_2', register);

    expect(shpPath).toBe('t_vector_2.shp');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_2.dbf',
      't_vector_2.shp',
      't_vector_2.shx',
    ]);
  });

  it('throws when the archive contains no .shp', async () => {
    const zip = zipSync({ 'notes.txt': strToU8('hi') });
    const { register } = recorder();

    await expect(registerZippedShapefile(zip, 't_vector_3', register)).rejects.toThrow(
      /\.shp/,
    );
  });
});
