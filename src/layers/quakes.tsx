import { use, useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { DEPTH, gradient, ramp } from '../colormap'
import { fmtLonLat, load, type Layer, type LayerContext } from '../layer'
import { projectGlobe } from '../project'
import { useUrlState } from '../url'
import { CORE } from './globe'

type Catalog = { source: string; fetched: string; rows: [number, number, number, number, number][] } // lon, lat, depth, mag, day
type Feed = { features: { geometry: { coordinates: [number, number, number] }; properties: { mag: number; place: string; time: number } }[] }

const LIVE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson'
const MAX_DEPTH = 700 // km, colour scale end (deepest event in the catalogue is ~692 km)

// Points sized by magnitude in screen pixels and hidden below the magnitude filter. `ring` draws hollow markers.
const vertexShader = /* glsl */ `
  attribute float mag;
  attribute vec3 tint;
  uniform float minMag, pixelRatio;
  varying vec3 vTint;
  void main() {
    vTint = tint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = mag < minMag ? 0.0 : (2.0 + (mag - 5.0) * 2.2) * pixelRatio;
  }`
const fragmentShader = /* glsl */ `
  uniform bool ring;
  varying vec3 vTint;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5 || (ring && r < 0.32)) discard;
    gl_FragColor = vec4(vTint, 1.0);
  }`

function points(rows: { lon: number; lat: number; depth: number; mag: number }[], white: boolean) {
  const at = ramp(DEPTH)
  const pos = new Float32Array(rows.length * 3), mag = new Float32Array(rows.length), tint = new Float32Array(rows.length * 3)
  rows.forEach((q, i) => {
    pos.set(projectGlobe(q.lon, q.lat, q.depth), i * 3)
    mag[i] = q.mag
    const c = white ? { r: 1, g: 1, b: 1 } : at(q.depth / MAX_DEPTH)
    tint.set([c.r, c.g, c.b], i * 3) // raw sRGB, like the slice LUT: no colour-space conversion in this shader
  })
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.BufferAttribute(pos, 3))
    .setAttribute('mag', new THREE.BufferAttribute(mag, 1))
    .setAttribute('tint', new THREE.BufferAttribute(tint, 3))
}

const material = (ring: boolean) =>
  new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { minMag: { value: 5 }, pixelRatio: { value: devicePixelRatio }, ring: { value: ring } } })

/** Pick tolerance follows zoom (~4 px), so small far-away points stay hoverable. */
function PickTolerance() {
  useFrame(({ raycaster, camera }) => {
    raycaster.params.Points.threshold = camera.position.length() * 0.004
  })
  return null
}

const core = new THREE.Sphere(new THREE.Vector3(), CORE)
/** The hovered point nearest the cursor's ray that passes the filter and isn't behind the Earth's core. */
function pick(e: ThreeEvent<PointerEvent>, object: THREE.Object3D, ok: (i: number) => boolean) {
  const hitCore = e.ray.intersectSphere(core, new THREE.Vector3())
  const coreDistance = hitCore ? hitCore.distanceTo(e.ray.origin) : Infinity
  const hits = e.intersections.filter((h) => h.object === object && h.index !== undefined && h.distance < coreDistance && ok(h.index))
  return hits.reduce<(typeof hits)[number] | undefined>((best, h) => (!best || h.distanceToRay! < best.distanceToRay! ? h : best), undefined)?.index
}

const day = (d: number) => new Date(d * 864e5).toISOString().slice(0, 10)

export function useQuakesLayer(ctx: LayerContext): Layer {
  const catalog = use(load<Catalog>('/data/quakes.json'))
  const [magParam, setMag] = useUrlState('mag', 5)
  const minMag = Math.min(8, Math.max(5, magParam))
  const [live, setLive] = useUrlState('live', 0)
  const [feed, setFeed] = useState<Feed | null>(null)
  const [feedError, setFeedError] = useState(false)

  const quakes = useMemo(() => catalog.rows.map(([lon, lat, depth, mag, d]) => ({ lon, lat, depth, mag, day: d })), [catalog])
  const geometry = useMemo(() => points(quakes, false), [quakes])
  const mat = useMemo(() => material(false), [])
  mat.uniforms.minMag.value = minMag
  const shown = useMemo(() => quakes.filter((q) => q.mag >= minMag).length, [quakes, minMag])

  useEffect(() => {
    if (!live || feed) return
    load<Feed>(LIVE_URL).then(setFeed, () => setFeedError(true))
  }, [live, feed])
  const liveRows = useMemo(
    () => feed?.features.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.geometry.coordinates[2], mag: f.properties.mag, place: f.properties.place, time: f.properties.time })) ?? [],
    [feed],
  )
  const liveGeometry = useMemo(() => points(liveRows, true), [liveRows])
  const liveMat = useMemo(() => {
    const m = material(true)
    m.uniforms.minMag.value = 4.5
    return m
  }, [])

  const object = useMemo(() => new THREE.Points(geometry, mat), [geometry, mat])
  const liveObject = useMemo(() => new THREE.Points(liveGeometry, liveMat), [liveGeometry, liveMat])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => liveGeometry.dispose(), [liveGeometry])

  const onHover = (e: ThreeEvent<PointerEvent>) => {
    const li = live ? pick(e, liveObject, () => true) : undefined
    if (li !== undefined) {
      const q = liveRows[li]
      e.stopPropagation()
      return ctx.setReadout(`Past week · M${q.mag.toFixed(1)} · ${q.depth.toFixed(0)} km deep · ${new Date(q.time).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${q.place}`)
    }
    const i = pick(e, object, (n) => quakes[n].mag >= minMag)
    if (i === undefined) return ctx.setReadout(null)
    e.stopPropagation()
    const q = quakes[i]
    ctx.setReadout(`M${q.mag.toFixed(1)} · ${q.depth.toFixed(0)} km deep · ${day(q.day)} · ${fmtLonLat(q.lon, q.lat)}`)
  }

  return {
    id: 'quakes',
    label: 'Earthquakes',
    scene: (
      <>
        <PickTolerance />
        <primitive object={object} onPointerMove={onHover} onPointerOut={() => ctx.setReadout(null)} />
        {live ? <primitive object={liveObject} onPointerMove={onHover} onPointerOut={() => ctx.setReadout(null)} /> : null}
      </>
    ),
    controls: (
      <>
        <div className="slider">
          <label htmlFor="mag">Smallest magnitude</label>
          <input id="mag" type="range" min={5} max={8} step={0.1} value={minMag} onChange={(e) => setMag(Number(e.target.value))} />
          <output>M{minMag.toFixed(1)}</output>
        </div>
        <p className="hint">
          {shown.toLocaleString()} of {quakes.length.toLocaleString()} earthquakes, plotted at their true depth. Point size grows with magnitude.
        </p>
        <figure className="colorbar">
          <div className="bar" style={{ background: gradient(DEPTH) }} />
          <div className="ticks">
            <span>0 km</span>
            <span>350</span>
            <span>{MAX_DEPTH} km</span>
          </div>
          <figcaption>
            <span>shallow</span> depth <span>deep</span>
          </figcaption>
        </figure>
        <label className="check">
          <input type="checkbox" checked={!!live} onChange={(e) => setLive(e.target.checked ? 1 : 0)} />
          Add the past 7 days, live from USGS (M4.5+, white rings)
        </label>
        {live && feedError ? <p className="hint">Couldn't reach the USGS live feed. The 2000–{catalog.fetched.slice(0, 4)} catalogue is still shown.</p> : null}
        {live && feed ? <p className="hint">{feed.features.length} earthquakes in the past week.</p> : null}
      </>
    ),
    credit: (
      <>
        Earthquakes: USGS ComCat (public domain), M5+ 2000–{catalog.fetched.slice(0, 4)}, fetched {catalog.fetched}
      </>
    ),
  }
}
