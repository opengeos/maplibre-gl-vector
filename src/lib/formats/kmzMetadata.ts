import type { FeatureCollection, GeoJsonProperties } from 'geojson';
import { unzipSync } from 'fflate';

const ICON_URL = '__geolibre_kml_icon_url';
const ICON_SCALE = '__geolibre_kml_icon_scale';

interface PlacemarkMetadata {
  name?: string;
  description?: string;
  iconHref?: string;
  iconScale?: number;
}

function children(element: Element, name: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.localName.toLowerCase() === name.toLowerCase(),
  );
}

function child(element: Element, name: string): Element | undefined {
  return children(element, name)[0];
}

function childText(element: Element, name: string): string | undefined {
  const value = child(element, name)?.textContent?.trim();
  return value || undefined;
}

function archiveEntry(
  entries: Record<string, Uint8Array>,
  href: string,
): [string, Uint8Array] | undefined {
  const normalize = (value: string) =>
    value
      .split(/[?#]/)[0]
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .toLowerCase();
  const target = normalize(href);
  const exact = Object.entries(entries).find(([name]) => normalize(name) === target);
  if (exact) return exact;
  const base = target.split('/').pop();
  const matches = Object.entries(entries).filter(
    ([name]) => normalize(name).split('/').pop() === base,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function imageMime(name: string): string | null {
  const extension = name.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'bmp') return 'image/bmp';
  return null;
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read a KMZ icon.'));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

function placemarkMetadata(text: string): PlacemarkMetadata[] {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) return [];
  const styles = new Map<string, { href?: string; scale?: number }>();
  const elements = Array.from(document.getElementsByTagName('*'));
  for (const style of elements.filter((element) => element.localName === 'Style')) {
    const id = style.getAttribute('id');
    const iconStyle = child(style, 'IconStyle');
    if (!id || !iconStyle) continue;
    const icon = child(iconStyle, 'Icon');
    const href = icon ? childText(icon, 'href') : undefined;
    const scaleValue = Number(childText(iconStyle, 'scale'));
    styles.set(id, {
      href,
      ...(Number.isFinite(scaleValue) && scaleValue > 0 ? { scale: scaleValue } : {}),
    });
  }

  return elements.filter((element) => element.localName === 'Placemark').map((placemark) => {
    const styleUrl = childText(placemark, 'styleUrl')?.replace(/^#/, '');
    const style = styleUrl ? styles.get(styleUrl) : undefined;
    return {
      name: childText(placemark, 'name'),
      description: childText(placemark, 'description'),
      iconHref: style?.href,
      iconScale: style?.scale,
    };
  });
}

function featureName(properties: GeoJsonProperties): string | undefined {
  const value = properties?.name ?? properties?.Name ?? properties?.NAME;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Restore KMZ placemark descriptions and embedded icons that GDAL's GeoJSON
 * conversion omits. Features are paired by name and occurrence order.
 */
export async function enhanceKmzGeoJSON(
  source: unknown,
  collection: FeatureCollection,
  sourceName?: string,
): Promise<FeatureCollection> {
  if (
    !source ||
    typeof source !== 'object' ||
    !('arrayBuffer' in source) ||
    typeof source.arrayBuffer !== 'function'
  ) {
    return collection;
  }
  const name =
    sourceName ?? ('name' in source && typeof source.name === 'string' ? source.name : '');
  if (name && !name.toLowerCase().endsWith('.kmz')) return collection;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  } catch {
    return collection;
  }
  const kml = Object.entries(entries).find(([entry]) => entry.toLowerCase().endsWith('.kml'));
  if (!kml) return collection;
  const metadata = placemarkMetadata(new TextDecoder().decode(kml[1]));
  if (!metadata.length) return collection;

  const byName = new Map<string, PlacemarkMetadata[]>();
  for (const item of metadata) {
    if (!item.name) continue;
    const queue = byName.get(item.name) ?? [];
    queue.push(item);
    byName.set(item.name, queue);
  }

  const iconUrls = new Map<string, Promise<string | null>>();
  const resolveIcon = (href: string) => {
    const cached = iconUrls.get(href);
    if (cached) return cached;
    const promise = (async () => {
      const found = archiveEntry(entries, href);
      if (!found) return null;
      const mime = imageMime(found[0]);
      return mime ? bytesToDataUrl(found[1], mime) : null;
    })();
    iconUrls.set(href, promise);
    return promise;
  };

  await Promise.all(
    collection.features.map(async (feature, index) => {
      const properties = (feature.properties ??= {});
      const nameValue = featureName(properties);
      const item = (nameValue ? byName.get(nameValue)?.shift() : undefined) ?? metadata[index];
      if (!item) return;
      for (const key of Object.keys(properties)) {
        const lower = key.toLowerCase();
        if ((lower === 'name' || lower === 'description') && key !== lower) {
          delete properties[key];
        }
      }
      if (item.name) properties.name = item.name;
      if (item.description) properties.description = item.description;
      if (item.iconScale) properties[ICON_SCALE] = item.iconScale;
      if (item.iconHref) {
        const url = await resolveIcon(item.iconHref);
        if (url) properties[ICON_URL] = url;
      }
    }),
  );
  return collection;
}

function iconHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Register embedded KMZ icons on the map and return a data-driven icon-image
 * expression, or null when the collection has none.
 */
export async function prepareKmzIcons(
  map: {
    hasImage(id: string): boolean;
    addImage(id: string, image: HTMLImageElement, options?: { pixelRatio?: number }): void;
  },
  collection: FeatureCollection,
): Promise<unknown[] | null> {
  const urls = new Set<string>();
  for (const feature of collection.features) {
    const value = feature.properties?.[ICON_URL];
    if (typeof value === 'string') urls.add(value);
  }
  if (!urls.size) return null;

  const matches: unknown[] = [];
  await Promise.all(
    Array.from(urls).map(
      (url) =>
        new Promise<void>((resolve) => {
          const id = `maplibre-vector-kml-${iconHash(url)}`;
          matches.push(url, id);
          if (map.hasImage(id)) {
            resolve();
            return;
          }
          const image = new Image();
          image.onload = () => {
            // ArcGIS KMZ exports bake their KML scale into a 2x raster (the
            // sample's icons are 60 px for an approximately 30 px symbol).
            if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
            resolve();
          };
          image.onerror = () => resolve();
          image.src = url;
        }),
    ),
  );
  return ['match', ['get', ICON_URL], ...matches, ''];
}
