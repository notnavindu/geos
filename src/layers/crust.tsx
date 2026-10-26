import { use, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { DEPTH, gradient, ramp } from '../colormap'
import { fmtLonLat, load, type Layer, type LayerContext } from '../layer'
import { MAX_THICKNESS, type Crust1 } from '../crust1'
import { projectGlobe } from '../project'
import { globeLines } from './globe'

export function useCrustLayer(ctx: LayerContext): Layer {
  const c = use(load<Crust1>('/data/crust1.json'))
  const world = use(load<[number, number][][]>('/data/world-coast.json'))
  // The globe's grey coastlines vanish on these colours, so this layer draws its own dark ones just above them.
  const coast = useMemo(() => globeLines(world, 13), [world])

  // A shell of cell centres coloured by crustal thickness; an extra column closes the seam at the antimeridian.
  const geometry = useMemo(() => {
    const { lon0, lat0, nlon, nlat } = c.grid
    const cols = nlon + 1, at = ramp(DEPTH), col = new THREE.Color()
    const pos = new Float32Array(cols * nlat * 3), colors = new Float32Array(cols * nlat * 3), cell = new Uint32Array(cols * nlat)
    for (let j = 0; j < nlat; j++)
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i, n = j * nlon + (i % nlon)
        pos.set(projectGlobe(lon0 + i, lat0 - j, -8), v * 3) // 8 km up: above the shell and graticule, below coastlines
        const { r, g, b } = at(c.thickness[n] / MAX_THICKNESS)
        colors.set(col.setRGB(r, g, b, THREE.SRGBColorSpace).toArray(), v * 3)
        cell[v] = n
      }
    const index: number[] = []
    for (let j = 0; j < nlat - 1; j++)
      for (let i = 0; i < nlon; i++) {
        const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1
        index.push(a, d, b, b, d, e)
      }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setIndex(index)
    geo.userData.cell = cell
    return geo
  }, [c])

  const onHover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const f = e.face!
    const pos = geometry.attributes.position as THREE.BufferAttribute
    const near = [f.a, f.b, f.c].reduce((a, b) => (new THREE.Vector3().fromBufferAttribute(pos, a).distanceTo(e.point) <= new THREE.Vector3().fromBufferAttribute(pos, b).distanceTo(e.point) ? a : b))
    const n = (geometry.userData.cell as Uint32Array)[near]
    const lon = c.grid.lon0 + (n % c.grid.nlon), lat = c.grid.lat0 - Math.floor(n / c.grid.nlon)
    ctx.setReadout(`CRUST1.0 · crust ${c.thickness[n].toFixed(1)} km thick · Moho ${c.moho[n].toFixed(1)} km below sea level · cell centred ${fmtLonLat(lon, lat)}`)
  }

  return {
    id: 'crust',
    label: 'Crustal thickness (CRUST1.0)',
    scene: (
      <>
        <mesh geometry={geometry} onPointerMove={onHover} onPointerOut={() => ctx.setReadout(null)}>
          <meshBasicMaterial vertexColors />
        </mesh>
        <lineSegments geometry={coast} raycast={() => null}>
          <lineBasicMaterial color="#1a1a19" />
        </lineSegments>
      </>
    ),
    controls: (
      <>
        <figure className="colorbar">
          <div className="bar" style={{ background: gradient(DEPTH) }} />
          <div className="ticks">
            <span>0 km</span>
            <span>35</span>
            <span>{MAX_THICKNESS}+ km</span>
          </div>
          <figcaption>
            <span>thinner</span> crustal thickness <span>thicker</span>
          </figcaption>
        </figure>
        <p className="hint">1° cells. About 5 km at mid-ocean ridges, 30–45 km under most continents, 80 km under western Tibet. It covers the earthquakes below, so turn it off to see them.</p>
      </>
    ),
    credit: (
      <>
        Crust: CRUST1.0, Laske et al. (2013), <a href={c.url}>igppweb.ucsd.edu/~gabi/crust1</a>
      </>
    ),
  }
}
