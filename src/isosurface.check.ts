// Run: npm run check
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Grid } from './layer.ts'
import { cellIndex, type Crust1 } from './crust1.ts'
import { crossingDepth, isosurface } from './isosurface.ts'

const g: Grid = JSON.parse(readFileSync(new URL('../public/data/vs.json', import.meta.url), 'utf8'))
const nx = g.lons.length, ny = g.lats.length
const depthOf = (lld: Float32Array) => Array.from({ length: lld.length / 3 }, (_, i) => lld[i * 3 + 2])

// Synthetic field value = depth: the 21 km surface (between grid depths 20 and 22) must be flat,
// every triangle facing down towards higher values.
const field = g.values.map((_, n) => g.depths[Math.floor(n / (nx * ny))])
const plane = isosurface({ ...g, values: field }, 21)
assert.ok(plane.index.length > 0)
assert.ok(depthOf(plane.lld).every((d) => Math.abs(d - 21) < 1e-4), 'vertices on the 21 km plane')
for (let t = 0; t < plane.index.length; t += 3) {
  const [a, b, c] = [0, 1, 2].map((i) => plane.index[t + i] * 3)
  const p = plane.positions
  const ny_ = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]) // y of (b-a)×(c-a)
  assert.ok(ny_ < 0, `triangle ${t / 3} faces up`)
}

// Exactly on a grid depth: vertices collapse onto nodes; no zero-area triangles, still flat.
const onNodes = isosurface({ ...g, values: field }, 20)
assert.ok(depthOf(onNodes.lld).every((d) => Math.abs(d - 20) < 1e-4))

// Real model: the 3.2 km/s surface stays shallow (basins), the 4.2 km/s surface sits at Moho-like depths.
assert.ok(depthOf(isosurface(g, 3.2).lld).every((d) => d < 15))
const moho = depthOf(isosurface(g, 4.2).lld)
assert.ok(moho.length > 0 && moho.every((d) => d > 20 && d < 70))
// Column lookups behind the CRUST1.0 comparison, against values checked by hand in the raw files:
// Mount Isa column (140.0°E 20.75°S) crosses 4.2 km/s between 42 km (4.109) and 44 km (4.222) → 43.6 km;
// CRUST1.0 cell 135.5°E 25.5°S has its Moho 31.92 km below sea level.
assert.ok(Math.abs(crossingDepth(g, 140, -20.75, 4.2)! - 43.61) < 0.02)
assert.equal(crossingDepth(g, 140, -20.75, 9), null)
const c: Crust1 = JSON.parse(readFileSync(new URL('../public/data/crust1.json', import.meta.url), 'utf8'))
assert.equal(c.moho[cellIndex(c, 135.5, -25.5)], 31.9)
assert.equal(cellIndex(c, 135.9, -25.1), cellIndex(c, 135.5, -25.5), 'same 1° cell')
assert.equal(cellIndex(c, -179.5, 89.5), 0)
console.log('isosurface: ok')
