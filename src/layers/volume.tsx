import { use, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { DIVERGING, SEQUENTIAL, gradient, lut } from '../colormap'
import { fmtLonLat, load, type Grid, type Layer, type LayerContext } from '../layer'
import { project } from '../project'
import { useUrlState } from '../url'

type Mode = 'dvs' | 'abs'
type Axis = 'depth' | 'lat' | 'lon'
const AXES: Axis[] = ['depth', 'lat', 'lon']
const nearest = (axis: number[], v: number) => axis.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(axis[best] - v) ? i : best), 0)

// Colour is looked up per pixel from the interpolated value, so blending between nodes happens in km/s, not RGB.
const vertexShader = /* glsl */ `
  attribute float value;
  varying float vValue;
  void main() {
    vValue = value;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const fragmentShader = /* glsl */ `
  uniform sampler2D lut;
  uniform float vmin, vmax;
  varying float vValue;
  void main() {
    gl_FragColor = texture2D(lut, vec2(clamp((vValue - vmin) / (vmax - vmin), 0.0, 1.0), 0.5));
  }`

/** % difference of each node from the mean of its depth layer, plus colour ranges for both modes. */
function derive(g: Grid) {
  const nx = g.lons.length, ny = g.lats.length, nz = g.depths.length, layer = nx * ny
  const dvs = new Float32Array(g.values.length)
  let min = Infinity, max = -Infinity
  for (let k = 0; k < nz; k++) {
    let sum = 0
    for (let n = k * layer; n < (k + 1) * layer; n++) sum += g.values[n]
    const mean = sum / layer
    for (let n = k * layer; n < (k + 1) * layer; n++) {
      dvs[n] = ((g.values[n] - mean) / mean) * 100
      min = Math.min(min, g.values[n])
      max = Math.max(max, g.values[n])
    }
  }
  // Symmetric dVs range at the 98th percentile of |dVs|, so a few extreme nodes don't wash out the rest.
  const sorted = Float32Array.from(dvs, Math.abs).sort()
  const m = Math.ceil(sorted[Math.floor(sorted.length * 0.98)])
  return {
    nx, ny, nz, dvs,
    range: { abs: [Math.floor(min * 10) / 10, Math.ceil(max * 10) / 10], dvs: [-m, m] } as Record<Mode, number[]>,
  }
}

type Derived = ReturnType<typeof derive>

/** A slice is a sheet of real grid nodes: one vertex per node, no resampling. */
function sheet(g: Grid, d: Derived, axis: Axis, idx: number, mode: Mode) {
  const { nx, ny, nz } = d
  const [nu, nv, node]: [number, number, (u: number, v: number) => number] =
    axis === 'depth' ? [nx, ny, (u, v) => (idx * ny + v) * nx + u]
    : axis === 'lat' ? [nx, nz, (u, v) => (v * ny + idx) * nx + u]
    : [ny, nz, (u, v) => (v * ny + u) * nx + idx]
  const values = mode === 'dvs' ? d.dvs : g.values

  const pos = new Float32Array(nu * nv * 3), val = new Float32Array(nu * nv), nodes = new Uint32Array(nu * nv)
  for (let v = 0; v < nv; v++)
    for (let u = 0; u < nu; u++) {
      const p = v * nu + u, n = node(u, v)
      pos.set(project(g.lons[n % nx], g.lats[Math.floor(n / nx) % ny], g.depths[Math.floor(n / (nx * ny))]), p * 3)
      val[p] = values[n]
      nodes[p] = n
    }
  const index: number[] = []
  for (let v = 0; v < nv - 1; v++)
    for (let u = 0; u < nu - 1; u++) {
      const a = v * nu + u, b = a + 1, c = a + nu, e = c + 1
      index.push(a, b, e, a, e, c)
    }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('value', new THREE.BufferAttribute(val, 1))
  geo.setIndex(index)
  geo.userData.nodes = nodes
  // Perimeter of the sheet, so slices stay distinguishable where they cross each other.
  const ring = [
    ...Array.from({ length: nu }, (_, u) => u),
    ...Array.from({ length: nv }, (_, v) => v * nu + nu - 1),
    ...Array.from({ length: nu }, (_, u) => (nv - 1) * nu + nu - 1 - u),
    ...Array.from({ length: nv }, (_, v) => (nv - 1 - v) * nu),
  ]
  geo.userData.outline = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(Float32Array.from(ring.flatMap((p) => [...pos.subarray(p * 3, p * 3 + 3)])), 3))
  return geo
}

/** Model outline: grid perimeter at the top and bottom depths plus the four corner edges. */
function frame(g: Grid) {
  const { lons, lats, depths } = g
  const [w, e, s, n] = [lons[0], lons.at(-1)!, lats[0], lats.at(-1)!]
  const ring: [number, number][] = [
    ...lons.map((lon): [number, number] => [lon, s]),
    ...lats.map((lat): [number, number] => [e, lat]),
    ...[...lons].reverse().map((lon): [number, number] => [lon, n]),
    ...[...lats].reverse().map((lat): [number, number] => [w, lat]),
  ]
  const [top, bottom] = [depths[0], depths.at(-1)!]
  const pts: number[] = []
  for (const depth of [top, bottom])
    for (let i = 1; i < ring.length; i++) pts.push(...project(...ring[i - 1], depth), ...project(...ring[i], depth))
  for (const [lon, lat] of [[w, s], [e, s], [e, n], [w, n]]) pts.push(...project(lon, lat, top), ...project(lon, lat, bottom))
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
}

/** Lines where the visible slices meet (fence-diagram style), so walls don't blend into the floor. */
function crossings(g: Grid, idx: Record<Axis, number>, show: (a: Axis) => boolean) {
  const { lons, lats, depths } = g
  const lon = lons[idx.lon], lat = lats[idx.lat], depth = depths[idx.depth]
  const runs: [number, number, number][][] = []
  if (show('depth') && show('lat')) runs.push(lons.map((x) => [x, lat, depth]))
  if (show('depth') && show('lon')) runs.push(lats.map((y) => [lon, y, depth]))
  if (show('lat') && show('lon')) runs.push(depths.map((d) => [lon, lat, d]))
  const pts = runs.flatMap((run) => run.slice(1).flatMap((p, i) => [...project(...run[i]), ...project(...p)]))
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
}

function Slice({ geometry, material, onHover, onLeave }: {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  onHover: (e: ThreeEvent<PointerEvent>) => void
  onLeave: () => void
}) {
  useEffect(() => () => (geometry.dispose(), geometry.userData.outline.dispose()), [geometry])
  return (
    <>
      <mesh geometry={geometry} material={material} onPointerMove={onHover} onPointerOut={onLeave} />
      <lineLoop geometry={geometry.userData.outline} raycast={() => null}>
        <lineBasicMaterial color="#1a1a19" />
      </lineLoop>
    </>
  )
}

function Colorbar({ stops, range, mode, units }: { stops: string[]; range: number[]; mode: Mode; units: string }) {
  const [lo, hi] = range
  const ticks = mode === 'dvs' ? [`−${-lo}%`, '0', `+${hi}%`] : [lo.toFixed(1), ((lo + hi) / 2).toFixed(2), hi.toFixed(1)]
  return (
    <figure className="colorbar">
      <div className="bar" style={{ background: gradient(stops) }} />
      <div className="ticks">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <figcaption>
        {mode === 'dvs' ? (
          <><span>slower</span> Vs vs. average at that depth <span>faster</span></>
        ) : (
          <><span>slower</span> Vs ({units}) <span>faster</span></>
        )}
      </figcaption>
    </figure>
  )
}

export function useVolumeLayer(ctx: LayerContext, url = '/data/vs.json', id = 'vs'): Layer {
  const g = use(load<Grid>(url))
  const d = useMemo(() => derive(g), [g])
  const outline = useMemo(() => frame(g), [g])

  // View state lives in the URL as real coordinates, snapped to the nearest grid node (so bad values clamp to the grid).
  // ponytail: URL keys aren't namespaced by layer id; prefix them if a second volume layer is ever added.
  const [modeParam, setMode] = useUrlState('mode', 'dvs')
  const mode: Mode = modeParam === 'abs' ? 'abs' : 'dvs'
  const [shown, setShown] = useUrlState('slices', AXES.join(','))
  const show = (a: Axis) => shown.split(',').includes(a)
  // Floor at 40 km (crust vs. mantle contrast), walls crossing central Australia standing on it.
  const [depth, setDepth] = useUrlState('depth', 40)
  const [lat, setLat] = useUrlState('lat', -26)
  const [lon, setLon] = useUrlState('lon', 134)
  const idx: Record<Axis, number> = { depth: nearest(g.depths, depth), lat: nearest(g.lats, lat), lon: nearest(g.lons, lon) }
  const setIdx: Record<Axis, (i: number) => void> = {
    depth: (k) => setDepth(g.depths[k]),
    lat: (j) => setLat(g.lats[j]),
    lon: (i) => setLon(g.lons[i]),
  }

  // Jumping to a place runs the vertical slices through it.
  useEffect(() => {
    if (!ctx.focus) return
    setLat(g.lats[nearest(g.lats, ctx.focus.lat)])
    setLon(g.lons[nearest(g.lons, ctx.focus.lon)])
  }, [ctx.focus, g, setLat, setLon])

  const materials = useMemo(() => {
    const make = (m: Mode) =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        uniforms: {
          lut: { value: lut(m === 'dvs' ? DIVERGING : SEQUENTIAL) },
          vmin: { value: d.range[m][0] },
          vmax: { value: d.range[m][1] },
        },
      })
    return { dvs: make('dvs'), abs: make('abs') }
  }, [d])

  const slices: { axis: Axis; label: string; count: number; format: (i: number) => string }[] = [
    { axis: 'depth', label: 'Depth', count: d.nz, format: (k) => `${g.depths[k]} km` },
    { axis: 'lat', label: 'East–west', count: d.ny, format: (j) => `${Math.abs(g.lats[j]).toFixed(2)}°S` },
    { axis: 'lon', label: 'North–south', count: d.nx, format: (i) => `${g.lons[i].toFixed(2)}°E` },
  ]
  const geometries = useMemo(
    () => Object.fromEntries(slices.map(({ axis }) => [axis, sheet(g, d, axis, idx[axis], mode)])) as Record<Axis, THREE.BufferGeometry>,
    [g, d, idx.depth, idx.lat, idx.lon, mode],
  )

  const meet = useMemo(() => crossings(g, idx, show), [g, idx.depth, idx.lat, idx.lon, shown])
  useEffect(() => () => meet.dispose(), [meet])

  // Readout snaps to the nearest real grid node of the hovered triangle.
  const onHover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const mesh = e.object as THREE.Mesh
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    const world = (i: number) => mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, i))
    const f = e.face!
    const best = [f.a, f.b, f.c].reduce((a, b) => (world(a).distanceTo(e.point) <= world(b).distanceTo(e.point) ? a : b))
    const n = (mesh.geometry.userData.nodes as Uint32Array)[best]
    const dv = d.dvs[n]
    ctx.setReadout(
      `${fmtLonLat(g.lons[n % d.nx], g.lats[Math.floor(n / d.nx) % d.ny])}  ${g.depths[Math.floor(n / (d.nx * d.ny))]} km  ·  ` +
        `Vs ${g.values[n].toFixed(2)} ${g.units}  (${dv >= 0 ? '+' : '−'}${Math.abs(dv).toFixed(1)}% vs. depth average)`,
    )
  }
  const onLeave = () => ctx.setReadout(null)

  return {
    id,
    label: 'Shear-wave velocity',
    scene: (
      <>
        <lineSegments geometry={outline} raycast={() => null}>
          <lineBasicMaterial color="#5a5955" />
        </lineSegments>
        <lineSegments geometry={meet} raycast={() => null}>
          <lineBasicMaterial color="#1a1a19" />
        </lineSegments>
        {slices
          .filter((s) => show(s.axis))
          .map((s) => <Slice key={s.axis} geometry={geometries[s.axis]} material={materials[mode]} onHover={onHover} onLeave={onLeave} />)}
      </>
    ),
    controls: (
      <>
        <div className="segmented" role="radiogroup" aria-label="Colour by">
          {(['dvs', 'abs'] as const).map((m) => (
            <label key={m}>
              <input type="radio" name={`${id}-mode`} checked={mode === m} onChange={() => setMode(m)} />
              {m === 'dvs' ? 'vs. depth average' : 'Absolute Vs'}
            </label>
          ))}
        </div>
        <Colorbar stops={mode === 'dvs' ? DIVERGING : SEQUENTIAL} range={d.range[mode]} mode={mode} units={g.units} />
        {slices.map(({ axis, label, count, format }) => (
          <div className="slider" key={axis}>
            <label>
              <input
                type="checkbox"
                checked={show(axis)}
                onChange={(e) => setShown(AXES.filter((a) => (a === axis ? e.target.checked : show(a))).join(','))}
              />
              {label}
            </label>
            <input
              type="range"
              aria-label={`${label} slice position`}
              min={0}
              max={count - 1}
              value={idx[axis]}
              disabled={!show(axis)}
              onChange={(e) => setIdx[axis](Number(e.target.value))}
            />
            <output>{format(idx[axis])}</output>
          </div>
        ))}
      </>
    ),
    credit: (
      <>
        Vs model: <abbr title={g.citation}>{g.credit}</abbr>, <a href={g.doi}>{g.doi.replace('https://', '')}</a>, {g.license}
      </>
    ),
  }
}
