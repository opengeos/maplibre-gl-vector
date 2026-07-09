// @vitest-environment node
// fflate's zipSync checks `instanceof Uint8Array`, which fails under jsdom's
// cross-realm globals (it then mistakes byte values for nested directories).
// This helper is DOM-free, so run it in the node environment where the zip
// round-trip behaves as it does in a real (single-realm) browser.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  groupShapefileComponents,
  registerLooseShapefile,
  registerZippedShapefile,
} from '../src/lib/formats/shapefile';

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

    const { shpPath, prjWkt } = await registerZippedShapefile(
      zip,
      't_vector_1',
      register,
    );

    expect(shpPath).toBe('t_vector_1.shp');
    expect(prjWkt).toBe('prj');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_1.cpg',
      't_vector_1.dbf',
      't_vector_1.prj',
      't_vector_1.shp',
      't_vector_1.shx',
    ]);
    expect(registered.get('t_vector_1.dbf')).toEqual(strToU8('dbf'));
  });

  it('returns a null prjWkt when the archive has no .prj', async () => {
    const zip = zipSync({
      'states.shp': strToU8('shp'),
      'states.dbf': strToU8('dbf'),
      'states.shx': strToU8('shx'),
    });
    const { register } = recorder();

    const { prjWkt } = await registerZippedShapefile(
      zip,
      't_vector_noprj',
      register,
    );

    expect(prjWkt).toBeNull();
  });

  it('handles a shapefile nested in a subdirectory and ignores unrelated files', async () => {
    const zip = zipSync({
      'data/roads.shp': strToU8('shp'),
      'data/roads.dbf': strToU8('dbf'),
      'data/roads.shx': strToU8('shx'),
      'data/readme.txt': strToU8('hi'),
    });
    const { registered, register } = recorder();

    const { shpPath } = await registerZippedShapefile(zip, 't_vector_2', register);

    expect(shpPath).toBe('t_vector_2.shp');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_2.dbf',
      't_vector_2.shp',
      't_vector_2.shx',
    ]);
  });

  it('ignores macOS __MACOSX / AppleDouble entries and picks the real .shp', async () => {
    // A zip created by macOS Finder carries a `__MACOSX/` tree of AppleDouble
    // `._<name>` resource forks. `._states.shp` ends in `.shp` and, being listed
    // first, would be mistaken for the shapefile without the metadata filter.
    const zip = zipSync({
      '__MACOSX/._states.shp': strToU8('appledouble-junk'),
      '__MACOSX/._states.dbf': strToU8('appledouble-junk'),
      'states.shp': strToU8('shp'),
      'states.dbf': strToU8('dbf'),
      'states.shx': strToU8('shx'),
    });
    const { registered, register } = recorder();

    const { shpPath } = await registerZippedShapefile(zip, 't_vector_mac', register);

    expect(shpPath).toBe('t_vector_mac.shp');
    // Only the real components register; no AppleDouble bytes leak in.
    expect([...registered.keys()].sort()).toEqual([
      't_vector_mac.dbf',
      't_vector_mac.shp',
      't_vector_mac.shx',
    ]);
    expect(registered.get('t_vector_mac.shp')).toEqual(strToU8('shp'));
  });

  it('handles a subdirectory shapefile alongside its __MACOSX shadow', async () => {
    // The reported case: the shapefile sits in its own folder and the archive
    // also carries the parallel `__MACOSX/<folder>/._<name>` shadows.
    const zip = zipSync({
      '__MACOSX/layer.shp/._layer.shp': strToU8('appledouble-junk'),
      'layer.shp/layer.shp': strToU8('shp'),
      'layer.shp/layer.dbf': strToU8('dbf'),
      'layer.shp/layer.shx': strToU8('shx'),
    });
    const { registered, register } = recorder();

    const { shpPath } = await registerZippedShapefile(zip, 't_vector_dir', register);

    expect(shpPath).toBe('t_vector_dir.shp');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_dir.dbf',
      't_vector_dir.shp',
      't_vector_dir.shx',
    ]);
    expect(registered.get('t_vector_dir.shp')).toEqual(strToU8('shp'));
  });

  it('throws when the archive contains no .shp', async () => {
    const zip = zipSync({ 'notes.txt': strToU8('hi') });
    const { register } = recorder();

    await expect(registerZippedShapefile(zip, 't_vector_3', register)).rejects.toThrow(
      /\.shp/,
    );
  });
});

describe('registerLooseShapefile', () => {
  it('registers the .shp and each sidecar under the base name', async () => {
    const { registered, register } = recorder();

    const shpPath = await registerLooseShapefile(
      strToU8('shp'),
      [
        { extension: '.dbf', bytes: strToU8('dbf') },
        { extension: '.shx', bytes: strToU8('shx') },
        { extension: '.prj', bytes: strToU8('prj') },
      ],
      't_vector_1',
      register,
    );

    expect(shpPath).toBe('t_vector_1.shp');
    expect([...registered.keys()].sort()).toEqual([
      't_vector_1.dbf',
      't_vector_1.prj',
      't_vector_1.shp',
      't_vector_1.shx',
    ]);
    expect(registered.get('t_vector_1.shp')).toEqual(strToU8('shp'));
  });

  it('normalizes extensions (adds the dot, lowercases) and skips a stray .shp', async () => {
    const { registered, register } = recorder();

    await registerLooseShapefile(
      strToU8('shp'),
      [
        { extension: 'DBF', bytes: strToU8('dbf') },
        { extension: '.SHX', bytes: strToU8('shx') },
        { extension: '.shp', bytes: strToU8('other') },
      ],
      't_vector_2',
      register,
    );

    expect([...registered.keys()].sort()).toEqual([
      't_vector_2.dbf',
      't_vector_2.shp',
      't_vector_2.shx',
    ]);
    // The stray .shp companion did not overwrite the main .shp buffer.
    expect(registered.get('t_vector_2.shp')).toEqual(strToU8('shp'));
  });
});

describe('groupShapefileComponents', () => {
  it('pairs a .shp with its sidecars and drops the sidecars as standalone files', () => {
    const files = [
      { name: 'cities.shp' },
      { name: 'cities.shx' },
      { name: 'cities.dbf' },
      { name: 'cities.prj' },
      { name: 'cities.cpg' },
    ];

    const groups = groupShapefileComponents(files);

    expect(groups).toHaveLength(1);
    expect(groups[0].file.name).toBe('cities.shp');
    expect(groups[0].companions.map((c) => c.name).sort()).toEqual([
      'cities.cpg',
      'cities.dbf',
      'cities.prj',
      'cities.shx',
    ]);
  });

  it('matches case-insensitively and ignores non-sidecar files sharing the base', () => {
    const files = [
      { name: 'Roads.SHP' },
      { name: 'Roads.SHX' },
      { name: 'Roads.DBF' },
      { name: 'roads.csv' },
    ];

    const groups = groupShapefileComponents(files);

    // The .shp keeps its .shx/.dbf; the unrelated .csv loads on its own.
    const shp = groups.find((g) => /\.shp$/i.test(g.file.name));
    expect(shp?.companions.map((c) => c.name).sort()).toEqual(['Roads.DBF', 'Roads.SHX']);
    expect(groups.some((g) => g.file.name === 'roads.csv' && g.companions.length === 0)).toBe(
      true,
    );
  });

  it('passes non-shapefile files through unchanged and preserves order', () => {
    const files = [{ name: 'a.geojson' }, { name: 'b.parquet' }];

    const groups = groupShapefileComponents(files);

    expect(groups.map((g) => g.file.name)).toEqual(['a.geojson', 'b.parquet']);
    expect(groups.every((g) => g.companions.length === 0)).toBe(true);
  });

  it('leaves an orphan sidecar (no matching .shp) as a standalone file', () => {
    const files = [{ name: 'lonely.dbf' }];

    const groups = groupShapefileComponents(files);

    expect(groups).toHaveLength(1);
    expect(groups[0].file.name).toBe('lonely.dbf');
    expect(groups[0].companions).toEqual([]);
  });
});
