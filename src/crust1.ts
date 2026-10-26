// CRUST1.0 (Laske et al. 2013): 1° global crust model, as written by pipeline/prepare.mjs.
export type Crust1 = {
  citation: string
  url: string
  grid: { lon0: number; lat0: number; step: number; nlon: number; nlat: number }
  moho: number[] // km below sea level
  thickness: number[] // km
}
export const MAX_THICKNESS = 70 // km, colour scale end (Tibet reaches 80)

/** Index into the CRUST1.0 arrays for the 1° cell containing lon/lat. */
export const cellIndex = (c: Crust1, lon: number, lat: number) =>
  Math.min(c.grid.nlat - 1, Math.max(0, Math.floor(c.grid.lat0 + 0.5 - lat))) * c.grid.nlon + (((Math.floor(lon - c.grid.lon0 + 0.5) % 360) + 360) % 360)
