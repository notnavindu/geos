import { use, useDeferredValue, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { DEPTH, gradient, ramp } from '../colormap'
import { isosurface } from '../isosurface'
import { fmtLonLat, load, type Grid, type Layer, type LayerContext } from '../layer'
import { useUrlState } from '../url'

const PRESETS = [
  { label: 'Sediment basins', value: 3.2 }, // the paper ties shallow Vs < 3.2 km/s to sedimentary basins
  { label: 'Base of crust', value: 4.2 }, // a common Vs proxy for the crust–mantle transition (Moho)
]
const [MIN, MAX] = [2.8, 4.6]

export function useIsosurfaceLayer(ctx: LayerContext, url = '/data/vs.json'): Layer {
  const g = use(load<Grid>(url))
  const [param, setIso] = useUrlState('iso', 3.2)
  const iso = Math.min(MAX, Math.max(MIN, param))
  // Extraction takes ~50–80 ms; deferring it keeps the slider responsive while the surface catches up.
  const deferred = useDeferredValue(iso)

  // Coloured by depth (range fitted to this surface), so basin depth and crustal thickness read from any angle.
  const { geometry, range } = useMemo(() => {
    const s = isosurface(g, deferred)
    const depths = Array.from({ length: s.lld.length / 3 }, (_, i) => s.lld[i * 3 + 2])
    const range = depths.length
      ? [Math.floor(depths.reduce((a, b) => Math.min(a, b))), Math.ceil(depths.reduce((a, b) => Math.max(a, b)))]
      : [0, 0]
    const at = ramp(DEPTH), c = new THREE.Color()
    const colors = new Float32Array(depths.length * 3)
    depths.forEach((d, i) => {
      const { r, g: gr, b } = at((d - range[0]) / (range[1] - range[0] || 1))
      colors.set(c.setRGB(r, gr, b, THREE.SRGBColorSpace).toArray(), i * 3)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(s.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setIndex(s.index)
    geo.computeVertexNormals()
    geo.userData.lld = s.lld
    return { geometry: geo, range }
  }, [g, deferred])
  useEffect(() => () => geometry.dispose(), [geometry])

  // Readout from the nearest surface vertex, whose lon/lat/depth were interpolated along a grid edge.
  const onHover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const pos = geometry.attributes.position as THREE.BufferAttribute
    const world = (i: number) => e.object.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, i))
    const f = e.face!
    const best = [f.a, f.b, f.c].reduce((a, b) => (world(a).distanceTo(e.point) <= world(b).distanceTo(e.point) ? a : b))
    const lld = geometry.userData.lld as Float32Array
    ctx.setReadout(`${fmtLonLat(lld[best * 3], lld[best * 3 + 1])}  ·  ${deferred.toFixed(2)} km/s reached at ${lld[best * 3 + 2].toFixed(1)} km depth`)
  }

  return {
    id: 'iso',
    label: 'Velocity surface',
    scene: (
      <mesh geometry={geometry} onPointerMove={onHover} onPointerOut={() => ctx.setReadout(null)}>
        <meshStandardMaterial vertexColors roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
    ),
    controls: (
      <>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.value} aria-pressed={Math.abs(iso - p.value) < 1e-6} onClick={() => setIso(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="slider">
          <label htmlFor="iso">Surface at Vs</label>
          <input id="iso" type="range" min={MIN} max={MAX} step={0.05} value={iso} onChange={(e) => setIso(Number(e.target.value))} />
          <output>{iso.toFixed(2)} km/s</output>
        </div>
        <figure className="colorbar">
          <div className="bar" style={{ background: gradient(DEPTH) }} />
          <div className="ticks">
            <span>{range[0]} km</span>
            <span>{range[1]} km</span>
          </div>
          <figcaption>
            <span>shallower</span> depth of surface <span>deeper</span>
          </figcaption>
        </figure>
        <p className="hint">Wraps everything slower than {iso.toFixed(2)} km/s.</p>
      </>
    ),
  }
}
