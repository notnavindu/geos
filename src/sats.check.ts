// Run: npm run check
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fromEcf, projectGlobe } from './project.ts'
import { MASK, coverage, ecf, elevation, passes, subpoint, track, type SatFeed } from './sats.ts'

const feed: SatFeed = JSON.parse(readFileSync(new URL('../public/data/centauri.json', import.meta.url), 'utf8'))
const sats = track(feed)
const t0 = Date.parse(feed.satellites[0].EPOCH + 'Z') + 3600e3 // an hour after the element set's epoch

for (const s of sats) {
  const sub = subpoint(s, t0)!
  assert.ok(sub.alt > 400 && sub.alt < 700, `${s.name}: LEO altitude, got ${sub.alt}`)
  // Straight overhead from the sub-satellite point, below the horizon from the opposite side of the Earth.
  assert.ok(elevation(s, t0, sub) > 89, `${s.name}: not overhead at its own subpoint`)
  assert.ok(elevation(s, t0, { lon: sub.lon + 180, lat: -sub.lat }) < -60, `${s.name}: visible from the antipode`)
  // ECEF → scene matches the sphere projection at the same lon/lat/altitude (ellipsoid vs sphere: < ~25 km).
  const a = fromEcf(ecf(s, t0)!), b = projectGlobe(sub.lon, sub.lat, -sub.alt)
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 40, `${s.name}: ECEF and sphere disagree`)
}

// 24 h of passes over Olympic Dam: well-formed, rise and set at the mask, plausible durations for ~550 km orbits.
const site = { lon: 136.88, lat: -30.44 }
const ps = passes(sats, site, t0, 24)
assert.ok(ps.length > 5, `only ${ps.length} passes`)
const end = t0 + 24 * 3600e3
for (const p of ps) {
  assert.ok(p.aos < p.los && p.maxEl >= MASK)
  if (p.aos > t0 && p.los < end) {
    assert.ok(p.los - p.aos < 16 * 60e3, `${p.sat}: ${(p.los - p.aos) / 60e3} min pass`)
    for (const t of [p.aos, p.los]) {
      const s = sats.find((x) => x.name === p.sat)!
      assert.ok(Math.abs(elevation(s, t, site) - MASK) < 0.5, `${p.sat}: rise/set not at ${MASK}°`)
    }
  }
}
const c = coverage(ps, t0, end)
assert.ok(c.next && c.longest.to - c.longest.from > 0 && c.longest.to - c.longest.from < 24 * 3600e3)
console.log(`sats: ok (${ps.length} passes over Olympic Dam in 24 h, longest wait ${Math.round((c.longest.to - c.longest.from) / 60e3)} min)`)
