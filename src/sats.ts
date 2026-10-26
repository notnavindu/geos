import { ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js'

export type SatFeed = { source: string; fetched: string; satellites: OMMJsonObject[] }
export type Sat = { name: string; omm: OMMJsonObject; satrec: SatRec }
export type Site = { lon: number; lat: number }
export type Pass = { sat: string; aos: number; los: number; maxEl: number } // epoch ms, degrees

export const MASK = 10 // degrees above the horizon before a ground sensor counts a satellite as reachable
const rad = Math.PI / 180

/** The Worker's cached copy in production; the bundled snapshot in dev or when the Worker can't answer. */
async function fetchFeed(): Promise<SatFeed> {
  for (const url of ['/api/satellites', '/data/centauri.json']) {
    try {
      const res = await fetch(url)
      if (res.ok && res.headers.get('content-type')?.includes('json')) return await res.json()
    } catch {
      // fall through to the next source
    }
  }
  throw new Error('No satellite data available')
}
let feed: Promise<SatFeed> | undefined
export const satelliteFeed = () => (feed ??= fetchFeed())

export const track = (f: SatFeed): Sat[] =>
  f.satellites.map((omm) => ({ name: omm.OBJECT_NAME.charAt(0) + omm.OBJECT_NAME.slice(1).toLowerCase(), omm, satrec: json2satrec(omm) }))

/** Earth-fixed position in km at time t (ms), or null when SGP4 can't propagate. */
export function ecf(s: Sat, t: number) {
  const date = new Date(t)
  const pv = propagate(s.satrec, date)
  return pv ? eciToEcf(pv.position, gstime(date)) : null
}

/** Point on the ground under the satellite, and its altitude. */
export function subpoint(s: Sat, t: number) {
  const date = new Date(t)
  const pv = propagate(s.satrec, date)
  if (!pv) return null
  const g = eciToGeodetic(pv.position, gstime(date))
  return { lon: g.longitude / rad, lat: g.latitude / rad, alt: g.height }
}

/** Degrees above the site's horizon (negative below it). */
export function elevation(s: Sat, t: number, site: Site) {
  const p = ecf(s, t)
  return p ? ecfToLookAngles({ longitude: site.lon * rad, latitude: site.lat * rad, height: 0 }, p).elevation / rad : -90
}

/**
 * Every pass above MASK over the site in [start, start + hours]. Elevation is sampled every 30 s; rise and set times are
 * interpolated between samples. ponytail: peak elevation is the highest sample, so it can read up to ~1° low.
 */
export function passes(sats: Sat[], site: Site, start: number, hours = 24, step = 30_000): Pass[] {
  const end = start + hours * 3600e3
  const cross = (t0: number, e0: number, t1: number, e1: number) => t0 + ((MASK - e0) / (e1 - e0)) * (t1 - t0)
  const out: Pass[] = []
  for (const s of sats) {
    let prevT = start, prevE = elevation(s, start, site)
    let open: Pass | null = prevE >= MASK ? { sat: s.name, aos: start, los: end, maxEl: prevE } : null
    for (let t = start + step; t <= end; t += step) {
      const e = elevation(s, t, site)
      if (!open && e >= MASK) open = { sat: s.name, aos: cross(prevT, prevE, t, e), los: end, maxEl: e }
      if (open) {
        open.maxEl = Math.max(open.maxEl, e)
        if (e < MASK) {
          open.los = cross(prevT, prevE, t, e)
          out.push(open)
          open = null
        }
      }
      prevT = t
      prevE = e
    }
    if (open) out.push(open) // still overhead when the window ends
  }
  return out.sort((a, b) => a.aos - b.aos)
}

/** Next pass, passes in the window, and the longest stretch with no satellite above the mask. */
export function coverage(ps: Pass[], start: number, end: number) {
  let longest = { from: start, to: start }, cursor = start
  for (const p of ps) {
    if (p.aos - cursor > longest.to - longest.from) longest = { from: cursor, to: p.aos }
    cursor = Math.max(cursor, p.los)
  }
  if (end - cursor > longest.to - longest.from) longest = { from: cursor, to: end }
  return { next: ps.find((p) => p.los > start) ?? null, count: ps.length, longest }
}

const pad = (n: number) => String(n).padStart(2, '0')
export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60e3)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`
}
export const fmtClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
