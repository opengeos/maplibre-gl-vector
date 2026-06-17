import { describe, it, expect } from 'vitest';
import {
  rebaseDuckDBBundles,
  spatialExtensionLoadSql,
  DUCKDB_CDN_BASE,
} from '../src/lib/engine/duckdbLoader';

/** Mirrors the shape duckdb-wasm's getJsDelivrBundles() returns. */
const sampleBundles = () => ({
  mvp: {
    mainModule: `${DUCKDB_CDN_BASE}/dist/duckdb-mvp.wasm`,
    mainWorker: `${DUCKDB_CDN_BASE}/dist/duckdb-browser-mvp.worker.js`,
  },
  eh: {
    mainModule: `${DUCKDB_CDN_BASE}/dist/duckdb-eh.wasm`,
    mainWorker: `${DUCKDB_CDN_BASE}/dist/duckdb-browser-eh.worker.js`,
  },
});

describe('rebaseDuckDBBundles', () => {
  it('returns the bundles unchanged for the default jsDelivr base', () => {
    const bundles = sampleBundles();
    expect(rebaseDuckDBBundles(bundles, DUCKDB_CDN_BASE)).toEqual(bundles);
  });

  it('rewrites bundle URLs to a self-hosted base, preserving /dist paths and filenames', () => {
    const out = rebaseDuckDBBundles(sampleBundles(), '/vendor/duckdb-wasm-1.31.0');
    expect(out.eh.mainModule).toBe('/vendor/duckdb-wasm-1.31.0/dist/duckdb-eh.wasm');
    expect(out.eh.mainWorker).toBe(
      '/vendor/duckdb-wasm-1.31.0/dist/duckdb-browser-eh.worker.js',
    );
    expect(out.mvp.mainModule).toBe('/vendor/duckdb-wasm-1.31.0/dist/duckdb-mvp.wasm');
  });

  it('rewrites to an absolute custom CDN host', () => {
    const out = rebaseDuckDBBundles(sampleBundles(), 'https://assets.example.com/duckdb');
    expect(out.eh.mainModule).toBe(
      'https://assets.example.com/duckdb/dist/duckdb-eh.wasm',
    );
  });

  it('normalizes a trailing slash on the custom base', () => {
    const out = rebaseDuckDBBundles(sampleBundles(), 'https://assets.example.com/duckdb/');
    expect(out.eh.mainModule).toBe(
      'https://assets.example.com/duckdb/dist/duckdb-eh.wasm',
    );
  });

  it('does not mutate the input bundles', () => {
    const bundles = sampleBundles();
    rebaseDuckDBBundles(bundles, '/vendor/x');
    expect(bundles.eh.mainModule).toBe(`${DUCKDB_CDN_BASE}/dist/duckdb-eh.wasm`);
  });
});

describe('spatialExtensionLoadSql', () => {
  it('installs from the remote repository by default', () => {
    expect(spatialExtensionLoadSql()).toBe('INSTALL spatial; LOAD spatial;');
    expect(spatialExtensionLoadSql('')).toBe('INSTALL spatial; LOAD spatial;');
  });

  it('loads a local extension path without a remote INSTALL', () => {
    expect(spatialExtensionLoadSql('/vendor/spatial.duckdb_extension')).toBe(
      "LOAD '/vendor/spatial.duckdb_extension'",
    );
  });

  it('normalizes Windows path separators', () => {
    expect(spatialExtensionLoadSql('C:\\ext\\spatial.duckdb_extension')).toBe(
      "LOAD 'C:/ext/spatial.duckdb_extension'",
    );
  });

  it('escapes single quotes in the path literal', () => {
    expect(spatialExtensionLoadSql("/o'brien/spatial.duckdb_extension")).toBe(
      "LOAD '/o''brien/spatial.duckdb_extension'",
    );
  });
});
