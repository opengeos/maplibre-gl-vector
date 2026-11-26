/**
 * Feature property that carries a KML/KMZ placemark's resolved icon URL.
 *
 * Point features that have it are drawn by the control's icon layer (and
 * filtered out of its circle layer). Hosts that take over a layer's features
 * can test for this property to leave icon-styled KML layers with the control.
 * Part of the public API: renaming it is a breaking change.
 */
export const KML_ICON_URL_PROPERTY = '__geolibre_kml_icon_url';
