// Every layer places geometry through one of these, so all layers in a view share one frame.
// Australia view, project(): Albers equal-area with the standard parallels of GDA94 Australian Albers (EPSG:3577), centred on the model.
// ponytail: spherical Earth, not the GRS80 ellipsoid (<0.5% scale error); swap in proj4 if a layer needs survey accuracy.
export const R = 6371 // km, mean Earth radius
const rad = Math.PI / 180
const LON0 = 133.625, LAT0 = -27.5
const P1 = -18 * rad, P2 = -36 * rad
const n = (Math.sin(P1) + Math.sin(P2)) / 2
const C = Math.cos(P1) ** 2 + 2 * n * Math.sin(P1)
const rho = (lat: number) => (R * Math.sqrt(C - 2 * n * Math.sin(lat * rad))) / n
const RHO0 = rho(LAT0)

/** lon/lat in degrees, depth in km (positive down) → scene [x, y, z] in km. Three is y-up: x east, y up, -z north. */
export function project(lon: number, lat: number, depthKm = 0): [number, number, number] {
  const r = rho(lat)
  const t = n * (lon - LON0) * rad
  return [r * Math.sin(t), -depthKm, -(RHO0 - r * Math.cos(t))]
}

// Globe view, projectGlobe(): true-scale sphere, km. Three is y-up: +y north pole, +z at lon 0, +x at lon 90°E.
// ponytail: spherical Earth (satellite positions are exact ECEF, so the sphere puts them up to ~21 km off); fine at globe scale.
/** lon/lat in degrees, depth in km (positive down, negative = altitude) → scene [x, y, z] in km. */
export function projectGlobe(lon: number, lat: number, depthKm = 0): [number, number, number] {
  const r = R - depthKm, la = lat * rad, lo = lon * rad
  return [r * Math.cos(la) * Math.sin(lo), r * Math.sin(la), r * Math.cos(la) * Math.cos(lo)]
}

/** Earth-centred Earth-fixed km (x to lon 0, y to lon 90°E, z north, as satellite.js returns) → globe scene frame. */
export const fromEcf = (p: { x: number; y: number; z: number }): [number, number, number] => [p.y, p.z, p.x]
