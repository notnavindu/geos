import type { Grid } from './layer.ts'
import { project } from './project.ts'

type V3 = number[]
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const mean = (ps: V3[]) => [0, 1, 2].map((i) => ps.reduce((s, p) => s + p[i], 0) / ps.length)

// Kuhn triangulation: 6 tetrahedra per cell, all along the 0→7 diagonal, so neighbouring cells' faces match
// and the surface has no cracks. Corner c sits at index offset (c & 1, c >> 1 & 1, c >> 2 & 1) in (lon, lat, depth).
const TETS = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]]

/**
 * Marching tetrahedra: the surface where the grid crosses `iso`, with triangles facing higher values.
 * Vertices lie on grid edges, interpolated in lon/lat/depth (so non-uniform depth spacing is honoured), then projected.
 */
export function isosurface(g: Grid, iso: number) {
  const { lons, lats, depths, values: v } = g
  const nx = lons.length, ny = lats.length, nz = depths.length, N = v.length
  const node = (n: number) => [lons[n % nx], lats[Math.floor(n / nx) % ny], depths[Math.floor(n / (nx * ny))]]
  const scene = (n: number) => { const [lon, lat, d] = node(n); return project(lon, lat, d) }

  const positions: number[] = [], lld: number[] = [], index: number[] = []
  const edges = new Map<number, number>() // shared edge → vertex id, so the mesh is indexed and smooth-shaded
  const vertex = (a: number, b: number) => {
    // A node exactly on iso is one vertex however many edges reach it; otherwise one vertex per edge.
    const key = v[a] === iso ? -1 - a : v[b] === iso ? -1 - b : a < b ? a * N + b : b * N + a
    let id = edges.get(key)
    if (id === undefined) {
      const t = (iso - v[a]) / (v[b] - v[a]), pa = node(a), pb = node(b)
      const p = pa.map((x, i) => x + t * (pb[i] - x))
      id = lld.length / 3
      lld.push(...p)
      positions.push(...project(p[0], p[1], p[2]))
      edges.set(key, id)
    }
    return id
  }
  const at = (id: number) => positions.slice(id * 3, id * 3 + 3)
  const tri = (a: number, b: number, c: number, toHigh: V3) => {
    if (a === b || b === c || a === c) return // collapsed onto a node that sits exactly on iso
    const pa = at(a)
    index.push(...(dot(cross(sub(at(b), pa), sub(at(c), pa)), toHigh) >= 0 ? [a, b, c] : [a, c, b]))
  }

  const corner = new Array<number>(8)
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let below = 0
        for (let c = 0; c < 8; c++) {
          corner[c] = ((k + (c >> 2)) * ny + j + ((c >> 1) & 1)) * nx + i + (c & 1)
          if (v[corner[c]] < iso) below++
        }
        if (below === 0 || below === 8) continue

        for (const tet of TETS) {
          const ns = tet.map((t) => corner[t])
          const lo = ns.filter((n) => v[n] < iso), hi = ns.filter((n) => v[n] >= iso)
          if (lo.length === 0 || hi.length === 0) continue
          const toHigh = sub(mean(hi.map(scene)), mean(lo.map(scene)))
          if (lo.length === 2) {
            const [a, b] = lo, [c, d] = hi
            const ac = vertex(a, c), ad = vertex(a, d), bd = vertex(b, d), bc = vertex(b, c)
            tri(ac, ad, bd, toHigh)
            tri(ac, bd, bc, toHigh)
          } else {
            const [apex, rest] = lo.length === 1 ? [lo[0], hi] : [hi[0], lo]
            tri(vertex(apex, rest[0]), vertex(apex, rest[1]), vertex(apex, rest[2]), toHigh)
          }
        }
      }

  return { positions: new Float32Array(positions), lld: new Float32Array(lld), index }
}

/** Depth where Vs first reaches `vs` going down the model column nearest lon/lat, interpolated between grid depths. */
export function crossingDepth(g: Grid, lon: number, lat: number, vs: number) {
  const nx = g.lons.length, ny = g.lats.length
  const i = Math.round((lon - g.lons[0]) / (g.lons[1] - g.lons[0])), j = Math.round((lat - g.lats[0]) / (g.lats[1] - g.lats[0]))
  if (i < 0 || i >= nx || j < 0 || j >= ny) return null
  for (let k = 1; k < g.depths.length; k++) {
    const a = g.values[((k - 1) * ny + j) * nx + i], b = g.values[(k * ny + j) * nx + i]
    if (a < vs && b >= vs) return g.depths[k - 1] + ((vs - a) / (b - a)) * (g.depths[k] - g.depths[k - 1])
  }
  return null
}
