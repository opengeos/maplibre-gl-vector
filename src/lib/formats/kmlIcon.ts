/**
 * Feature property that carries a KML/KMZ placemark's resolved icon URL.
 *
 * The KML/KMZ reader sets it on placemarks whose style names an icon. When
 * such a layer is a point layer drawn without clustering, the control adds an
 * icon symbol layer for the features that have it and filters them out of the
 * circle layer; a clustered layer draws them as ordinary circles. Hosts that
 * take over a layer's features can test for this property to leave
 * icon-styled KML layers with the control. Part of the public API: renaming it
 * is a breaking change.
 */
export const KML_ICON_URL_PROPERTY = '__geolibre_kml_icon_url';
