import { Fragment, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { Ray, Sphere, Vector3 } from 'three'
import type { Layer, LayerContext, ViewName } from './layer'
import { useCoastlineLayer } from './layers/coastline'
import { useCrustLayer } from './layers/crust'
import { useGlobeLayer } from './layers/globe'
import { useIsosurfaceLayer } from './layers/isosurface'
import { useMohoLayer } from './layers/moho'
import { usePlacesLayer } from './layers/places'
import { useQuakesLayer } from './layers/quakes'
import { useSatellitesLayer } from './layers/satellites'
import { useVolumeLayer } from './layers/volume'
import { CONTINENT, PLACES, type Place } from './places'
import { R, project, projectGlobe } from './project'
import { getParam, setParam, useUrlState } from './url'

type Pose = { position: number[]; target: number[] }
type Flight = { to: Pose; from?: Pose; then?: () => void }

// Portrait screens see less horizontally: back the camera off so the whole model fits. Panel starts closed on phones.
const fit = Math.max(1, (1.3 * innerHeight) / innerWidth)
const narrow = innerWidth <= 640
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

const CAM_KEY: Record<ViewName, string> = { australia: 'cam', globe: 'gcam' }
const savedPose = (view: ViewName): Pose | null => {
  const c = getParam(CAM_KEY[view])?.split(',').map(Number)
  return c?.length === 6 && c.every(Number.isFinite) ? { position: c.slice(0, 3), target: c.slice(3) } : null
}
/** Globe camera looking at the Earth's centre from above lon/lat, `distance` km from the centre. */
const globeAt = (lon: number, lat: number, distance: number): Pose => ({ position: projectGlobe(lon, lat, R - distance), target: [0, 0, 0] })

const GLOBE_HOME = globeAt(134, -20, 26000 * fit)
const OVER_AUSTRALIA = globeAt(134, -27, R + 4500)
const CONTINENT_VIEW: Pose = { position: [2000 * fit, 2300 * fit, 5400 * fit], target: [0, -300, 0] }
const START: Record<ViewName, Pose> = { globe: savedPose('globe') ?? GLOBE_HOME, australia: savedPose('australia') ?? CONTINENT_VIEW }

/** Look at a place from the south-east (both walls face the camera), aimed 20 km down at the slices under it. */
function australiaPose(place: Place, exaggeration: number): Pose {
  if (place === CONTINENT) return CONTINENT_VIEW
  const [x, , z] = project(place.lon, place.lat)
  const target = [x, -20 * exaggeration, z]
  return { target, position: [x + 1800 * fit, target[1] + 1600 * fit, z + 2200 * fit] }
}
const globePose = (place: Place) => (place === CONTINENT ? GLOBE_HOME : globeAt(place.lon, place.lat, R + 9000 * fit))

/** One camera; each view remembers its own pose (and saves it to the URL). Flights animate between poses. */
function Orbit({ view, flight }: { view: ViewName; flight: Flight | null }) {
  const { camera, gl } = useThree()
  const [controls, setControls] = useState<OrbitControls>()
  const current = useRef(view)
  current.current = view
  const poses = useRef({ ...START })

  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement)
    const save = () => setParam(CAM_KEY[current.current], [...camera.position.toArray(), ...c.target.toArray()].map(Math.round).join(','))
    c.addEventListener('end', save)
    setControls(c)
    return () => {
      c.removeEventListener('end', save)
      c.dispose()
    }
  }, [camera, gl])

  const apply = (c: OrbitControls, p: Pose) => {
    camera.position.fromArray(p.position)
    c.target.fromArray(p.target)
    c.update()
  }

  useEffect(() => {
    if (!controls) return
    apply(controls, poses.current[view])
    // The globe orbits its centre at a safe distance; the Australia box can be panned and approached freely.
    Object.assign(controls, view === 'globe' ? { minDistance: R + 900, maxDistance: 90000, enablePan: false } : { minDistance: 0, maxDistance: Infinity, enablePan: true })
    // Depth precision scales with near/far: a 50 km near plane resolves the globe's surface layers (a few km apart)
    // from 26,000 km away; the Australia box needs a close near plane instead.
    ;(camera as THREE.PerspectiveCamera).near = view === 'globe' ? 50 : 1
    camera.updateProjectionMatrix()
    return () => {
      poses.current[view] = { position: camera.position.toArray(), target: controls.target.toArray() }
    }
  }, [controls, view])

  // Smoothstep over 0.9 s (instant with reduced motion), then save the pose and run the flight's follow-up.
  useEffect(() => {
    if (!controls || !flight) return
    if (flight.from) apply(controls, flight.from)
    const from = { position: camera.position.clone(), target: controls.target.clone() }
    const [p, t] = [flight.to.position, flight.to.target]
    const start = performance.now(), duration = reducedMotion ? 0 : 900
    let frame = requestAnimationFrame(function step(now) {
      const k = duration ? Math.min(1, (now - start) / duration) : 1, e = k * k * (3 - 2 * k)
      camera.position.copy(from.position).lerp({ x: p[0], y: p[1], z: p[2] }, e)
      controls.target.copy(from.target).lerp({ x: t[0], y: t[1], z: t[2] }, e)
      controls.update()
      if (k < 1) frame = requestAnimationFrame(step)
      else {
        controls.dispatchEvent({ type: 'end' })
        flight.then?.()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [controls, flight])

  return null
}

const surface = new Sphere(new Vector3(), R)
const ray = new Ray(), hit = new Vector3(), at = new Vector3()

/** Draws DOM labels (CSS2DObjects) over the canvas, in step with the WebGL frame. On the globe, labels behind the Earth hide. */
function Labels({ globe }: { globe: boolean }) {
  const { scene, camera, gl, size } = useThree()
  const [renderer] = useState(() => new CSS2DRenderer())
  useEffect(() => {
    renderer.domElement.className = 'labels'
    gl.domElement.parentElement!.append(renderer.domElement)
    return () => renderer.domElement.remove()
  }, [renderer, gl])
  useEffect(() => renderer.setSize(size.width, size.height), [renderer, size])
  useFrame(() => {
    scene.traverse((o) => {
      if (!(o instanceof CSS2DObject)) return
      o.getWorldPosition(at)
      ray.set(camera.position, at.clone().sub(camera.position).normalize())
      o.visible = !(globe && ray.intersectSphere(surface, hit) && hit.distanceTo(camera.position) < at.distanceTo(camera.position) - 1)
    })
    renderer.render(scene, camera)
  })
  return null
}

const COPY: Record<ViewName, { title: string; intro: string; readout: string }> = {
  globe: {
    title: 'From orbit to 700 km down',
    intro: "Fleet's Centauri satellites 500–600 km up, 48,000 earthquakes down to 690 km and the thickness of the crust, all at true scale.",
    readout: 'Hover an earthquake, a satellite or the crust to read it',
  },
  australia: {
    title: 'Australian crust in 3D',
    intro: 'Shear-wave velocity to 70 km depth, imaged with ambient noise tomography from 1,600+ seismic stations.',
    readout: 'Hover a slice or surface to read the model',
  },
}

export default function App() {
  const [readout, setReadout] = useState<string | null>(null)
  const [focus, setFocus] = useState<Place | null>(null)
  const [viewParam, setView] = useUrlState('view', 'globe')
  const view: ViewName = viewParam === 'australia' ? 'australia' : 'globe'
  const [flight, setFlight] = useState<Flight | null>(null)
  const [exParam, setExaggeration] = useUrlState('ex', 15)
  const exaggeration = Math.min(40, Math.max(1, Math.round(exParam)))
  // Off at first: surfaces that would cover the slices or the earthquakes, and labels that collide on phones.
  const [hide, setHide] = useUrlState('hide', narrow ? 'iso,moho,crust,places' : 'iso,moho,crust')
  const hidden = hide ? hide.split(',') : []
  const [copied, setCopied] = useState<string | null>(null)

  const enter = (to: ViewName) => {
    if (to === view) return
    setReadout(null)
    if (to === 'australia') setFlight({ to: OVER_AUSTRALIA, then: () => setView('australia') })
    else {
      setView('globe')
      setFlight({ from: OVER_AUSTRALIA, to: GLOBE_HOME })
    }
  }

  // Picking a place flies the current view's camera there.
  useEffect(() => {
    if (focus) setFlight({ to: view === 'globe' ? globePose(focus) : australiaPose(focus, exaggeration) })
  }, [focus])

  // Every layer hook runs in both views (hook order stays fixed); only the current view's layers are drawn.
  // Add a layer here: draw order = array order.
  const ctx: LayerContext = { setReadout, focus, setFocus, enter }
  const layers: Record<ViewName, Layer[]> = {
    globe: [useGlobeLayer(ctx), useCrustLayer(ctx), useQuakesLayer(ctx), useSatellitesLayer(ctx)],
    australia: [useVolumeLayer(ctx), useIsosurfaceLayer(ctx), useMohoLayer(ctx), useCoastlineLayer(), usePlacesLayer(ctx)],
  }
  const active = layers[view]
  const visible = active.filter((l) => !hidden.includes(l.id))

  const copyLink = () => {
    const done = (msg: string) => (setCopied(msg), setTimeout(() => setCopied(null), 2000))
    navigator.clipboard.writeText(location.href).then(() => done('Link copied'), () => done('Copy blocked: use the address bar'))
  }

  return (
    <>
      <Canvas camera={{ position: START[view].position as [number, number, number], fov: 35, near: 1, far: 200000 }} onPointerMissed={() => setReadout(null)}>
        <color attach="background" args={['#1a1a19']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[2500, 3000, 1500]} intensity={1.8} />
        <Orbit view={view} flight={flight} />
        <Labels globe={view === 'globe'} />
        {view === 'globe' ? (
          visible.map((l) => <Fragment key={l.id}>{l.scene}</Fragment>)
        ) : (
          <group scale={[1, exaggeration, 1]}>
            {visible.map((l) => <Fragment key={l.id}>{l.scene}</Fragment>)}
          </group>
        )}
      </Canvas>

      <details className="panel" open={!narrow}>
        <summary>
          <h1>{COPY[view].title}</h1>
        </summary>
        <div className="segmented views" role="radiogroup" aria-label="View">
          {(['globe', 'australia'] as const).map((v) => (
            <label key={v}>
              <input type="radio" name="view" checked={view === v} onChange={() => enter(v)} />
              {v === 'globe' ? 'Globe' : 'Australia in 3D'}
            </label>
          ))}
        </div>
        <p className="intro">{COPY[view].intro}</p>

        <section>
          <label className="field">
            <span>Go to</span>
            <select
              value={focus?.name ?? ''}
              onChange={(e) => setFocus([CONTINENT, ...PLACES].find((p) => p.name === e.target.value) ?? CONTINENT)}
            >
              <option value="" disabled>
                Choose a place…
              </option>
              <option>{CONTINENT.name}</option>
              <optgroup label="Mineral districts and basins">
                {PLACES.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}: {p.kind}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </section>

        {active.map((l) => (
          <section key={l.id}>
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={!hidden.includes(l.id)}
                onChange={(e) => setHide((e.target.checked ? hidden.filter((h) => h !== l.id) : [...hidden, l.id]).join(','))}
              />
              {l.label}
            </label>
            {!hidden.includes(l.id) && l.controls}
          </section>
        ))}

        <section>
          {view === 'australia' ? (
            <div className="slider">
              <label htmlFor="exaggeration">Vertical exaggeration</label>
              <input id="exaggeration" type="range" min={1} max={40} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} />
              <output>×{exaggeration}</output>
            </div>
          ) : null}
          <button className="copy" onClick={copyLink}>
            {copied ?? 'Copy link to this view'}
          </button>
          <p className="hint">Drag to rotate · {view === 'australia' ? 'right-drag to pan · ' : ''}scroll to zoom</p>
        </section>
      </details>

      <div className="readout" aria-live="polite">{readout ?? COPY[view].readout}</div>

      <footer>
        {visible.filter((l) => l.credit).map((l) => <p key={l.id}>{l.credit}</p>)}
      </footer>
    </>
  )
}
