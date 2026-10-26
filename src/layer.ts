import type { ReactNode } from 'react'
import type { Place } from './places'

/**
 * A layer is a hook returning what it draws and the panel UI it needs.
 * Place geometry with project() and it lines up with every other layer.
 * Adding a layer = one file in layers/ + one line in App's `layers` array.
 */
export type Layer = {
  id: string
  label: string
  scene: ReactNode // rendered inside the shared world group (y scaled by vertical exaggeration)
  controls?: ReactNode // rendered in the side panel while the layer is visible
  credit?: ReactNode // attribution shown in the footer (real data needs its source cited)
}

export type LayerContext = {
  setReadout: (text: string | null) => void // hover readout at the bottom of the screen
  focus: Place | null // last place the user jumped to; layers may react (e.g. move slices through it)
  setFocus: (place: Place) => void
  enter: (view: ViewName) => void // switch view with a camera transition
}

export type ViewName = 'globe' | 'australia'

/** Any regular lon/lat/depth grid. values are flattened [depth][lat][lon]. */
export type Grid = {
  name: string
  units: string
  citation: string
  credit: string // short form for the footer
  doi: string
  license: string
  lons: number[]
  lats: number[]
  depths: number[]
  values: number[]
}

export const fmtLonLat = (lon: number, lat: number) =>
  `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}  ${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`

// Fetch once, cache the promise, and read it with React's use() (suspends until loaded).
const cache = new Map<string, Promise<unknown>>()
export function load<T>(url: string): Promise<T> {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`)))))
  return cache.get(url) as Promise<T>
}
