import { use, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { fmtLonLat, load, type Grid, type Layer, type LayerContext } from '../layer'
import { project } from '../project'
import { crossingDepth } from '../isosurface'
import { cellIndex, type Crust1 } from '../crust1'

const VS = 4.2 // km/s, this model's stand-in for the base of the crust (the velocity-surface preset)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** CRUST1.0's Moho under the Australian model, drawn as a mesh beside this model's 4.2 km/s depth, with per-cell differences. */
export function useMohoLayer(ctx: LayerContext): Layer {
  const c = use(load<Crust1>('/data/crust1.json'))
  const g = use(load<Grid>('/data/vs.json'))

  const { geometry, cells, stats } = useMemo(() => {
    // CRUST1.0 cell centres (x.5°) inside the model's extent.
    const lons: number[] = [], lats: number[] = []
    for (let lon = Math.ceil(g.lons[0] - 0.5) + 0.5; lon <= g.lons.at(-1)!; lon++) lons.push(lon)
    for (let lat = Math.ceil(g.lats[0] - 0.5) + 0.5; lat <= g.lats.at(-1)!; lat++) lats.push(lat)
    const cells = lats.flatMap((lat) =>
      lons.map((lon) => {
        const n = cellIndex(c, lon, lat)
        // On land the crust's top is at or above sea level, so its thickness is at least the Moho's depth below sea level.
        return { lon, lat, moho: c.moho[n], land: c.thickness[n] >= c.moho[n], ours: crossingDepth(g, lon, lat, VS) }
      }),
    )
    const pos = new Float32Array(cells.length * 3)
    cells.forEach((p, n) => pos.set(project(p.lon, p.lat, p.moho), n * 3))
    const index: number[] = []
    for (let j = 0; j < lats.length - 1; j++)
      for (let i = 0; i < lons.length - 1; i++) {
        const a = j * lons.length + i, b = a + 1, d = a + lons.length, e = d + 1
        index.push(a, b, e, a, e, d)
      }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setIndex(index)
    // Statistics over land only: offshore the Vs model has few stations, and oceanic crust is a different regime.
    const diffs = cells.filter((p) => p.land && p.ours !== null).map((p) => p.ours! - p.moho)
    return {
      geometry: geo,
      cells,
      stats: { n: diffs.length, median: median(diffs), absMedian: median(diffs.map(Math.abs)), deeper: diffs.filter((d) => d > 0).length / diffs.length },
    }
  }, [c, g])

  const onHover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const f = e.face!
    const pos = geometry.attributes.position as THREE.BufferAttribute
    const world = (i: number) => e.object.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, i))
    const p = cells[[f.a, f.b, f.c].reduce((a, b) => (world(a).distanceTo(e.point) <= world(b).distanceTo(e.point) ? a : b))]
    const ours = p.ours === null ? 'never reaches 4.2 km/s in this model' : `this model reaches ${VS} km/s at ${p.ours.toFixed(1)} km (${p.ours - p.moho >= 0 ? '+' : '−'}${Math.abs(p.ours - p.moho).toFixed(1)} km)`
    ctx.setReadout(`${fmtLonLat(p.lon, p.lat)}${p.land ? '' : ' (offshore)'} · CRUST1.0 Moho ${p.moho.toFixed(1)} km below sea level · ${ours}`)
  }

  return {
    id: 'moho',
    label: 'CRUST1.0 Moho (comparison)',
    scene: (
      <mesh geometry={geometry} onPointerMove={onHover} onPointerOut={() => ctx.setReadout(null)}>
        <meshBasicMaterial color="#e8e6df" wireframe transparent opacity={0.6} />
      </mesh>
    ),
    controls: (
      <>
        <p className="hint">
          The independent global model's Moho as a 1° mesh. Turn on the velocity surface at {VS} km/s (base of crust) to compare the two.
        </p>
        <p className="hint">
          Across {stats.n.toLocaleString()} land cells, this model reaches {VS} km/s a median{' '}
          <strong>
            {Math.abs(stats.median).toFixed(1)} km {stats.median >= 0 ? 'deeper' : 'shallower'}
          </strong>{' '}
          than CRUST1.0's Moho (median gap {stats.absMedian.toFixed(1)} km; deeper in {Math.round(stats.deeper * 100)}% of cells).
        </p>
        <p className="hint">
          Expect a gap. {VS} km/s is a proxy that tomography smooths, and CRUST1.0 measures from sea level, while Australia's land
          surface is mostly under 1 km.
        </p>
      </>
    ),
    credit: <>Moho comparison: CRUST1.0, Laske et al. (2013)</>,
  }
}
