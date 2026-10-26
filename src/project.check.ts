// Run: npm run check
import assert from 'node:assert/strict'
import { fromEcf, project, projectGlobe } from './project.ts'

const R = 6371, rad = Math.PI / 180
const near = (a: number, b: number, rel: number) => assert.ok(Math.abs(a / b - 1) < rel, `${a} vs ${b}`)

// Equal-area: a 1°×1° cell's projected area matches its area on the sphere, anywhere in the model.
for (const [lon, lat] of [[113, -44], [133, -27], [154, -11]]) {
  const quad = [[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1]].map(([a, b]) => project(a, b))
  const area = Math.abs(quad.reduce((s, p, i) => { const q = quad[(i + 1) % 4]; return s + p[0] * q[2] - q[0] * p[2] }, 0)) / 2
  near(area, R * R * rad * (Math.sin((lat + 1) * rad) - Math.sin(lat * rad)), 1e-3)
}
// Distances stay within ~2% (Albers trades a little shape for exact area).
const d = Math.hypot(...project(133.625, -27.5).map((v, i) => v - project(133.625, -28.5)[i]))
near(d, R * rad, 0.02)

assert.ok(project(133.625, -27.5).every((v) => Math.abs(v) < 1e-9), 'model centre → origin')
assert.ok(project(140, -27.5)[0] > 0, 'east is +x')
assert.ok(project(133.625, -20)[2] < 0, 'north is -z')
assert.equal(project(133.625, -27.5, 10)[1], -10, 'depth is -y')

// Globe: true radius, axes as documented, and the ECEF mapping agrees with projectGlobe.
const len = (v: number[]) => Math.hypot(...v)
near(len(projectGlobe(37, -12)), R, 1e-9)
near(len(projectGlobe(37, -12, 700)), R - 700, 1e-9)
near(len(projectGlobe(37, -12, -550)), R + 550, 1e-9)
assert.ok(projectGlobe(0, 0)[2] > R - 1e-6 && projectGlobe(90, 0)[0] > R - 1e-6 && projectGlobe(0, 90)[1] > R - 1e-6, 'globe axes')
const [lon, lat] = [133.6, -27.5].map((d) => d * rad)
const ecf = { x: R * Math.cos(lat) * Math.cos(lon), y: R * Math.cos(lat) * Math.sin(lon), z: R * Math.sin(lat) }
assert.ok(fromEcf(ecf).every((v, i) => Math.abs(v - projectGlobe(133.6, -27.5)[i]) < 1e-6), 'fromEcf matches projectGlobe')
console.log('project: ok')
