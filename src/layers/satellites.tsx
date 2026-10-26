import { use, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { fmtLonLat, type Layer, type LayerContext } from '../layer'
import { CONTINENT, type Place } from '../places'
import { fromEcf, projectGlobe } from '../project'
import { MASK, coverage, ecf, elevation, fmtClock, fmtDuration, passes, satelliteFeed, subpoint, track, type Sat } from '../sats'
import { useUrlState } from '../url'

type Clock = { t: number; speed: number } // simulated time (ms), advanced in the frame loop
const SPEEDS = [1, 60, 600]
const ORBIT_POINTS = 120
const DAY = 24 * 3600e3

function SatScene({ sats, clock, site, setReadout }: { sats: Sat[]; clock: React.RefObject<Clock>; site: Place | null; setReadout: (t: string | null) => void }) {
  const markers = useRef<(THREE.Mesh | null)[]>([])
  const labels = useMemo(
    () =>
      sats.map((s) => {
        // The label renderer owns the anchor's transform, so the offset lives on an inner element.
        const anchor = document.createElement('div')
        anchor.className = 'sat-label'
        anchor.append(Object.assign(document.createElement('span'), { textContent: s.name }))
        return new CSS2DObject(anchor)
      }),
    [sats],
  )
  // One orbit ahead of each satellite, Earth-fixed, so the line shows the ground it will fly over.
  const orbits = useMemo(
    () =>
      sats.map(() => {
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_POINTS * 3), 3))
        return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#c9cdc5', transparent: true, opacity: 0.45 }))
      }),
    [sats],
  )
  const links = useMemo(() => {
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(sats.length * 6), 3))
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#5598e7' }))
  }, [sats])
  useEffect(() => () => orbits.forEach((o) => o.geometry.dispose()), [orbits])
  const lastOrbit = useRef(-Infinity)

  useFrame((_, dt) => {
    const c = clock.current
    c.t += Math.min(dt, 0.1) * 1000 * c.speed
    const recompute = Math.abs(c.t - lastOrbit.current) > 30_000
    if (recompute) lastOrbit.current = c.t
    const sitePos = site && projectGlobe(site.lon, site.lat)
    const linkPos = links.geometry.attributes.position as THREE.BufferAttribute
    sats.forEach((s, i) => {
      const p = ecf(s, c.t)
      if (!p) return
      const v = fromEcf(p)
      markers.current[i]?.position.set(...v)
      labels[i].position.set(...v)
      if (recompute) {
        const period = DAY / Number(s.omm.MEAN_MOTION)
        const attr = orbits[i].geometry.attributes.position as THREE.BufferAttribute
        for (let k = 0; k < ORBIT_POINTS; k++) {
          const q = ecf(s, c.t + (k / (ORBIT_POINTS - 1)) * period)
          if (q) attr.setXYZ(k, ...fromEcf(q))
        }
        attr.needsUpdate = true
        orbits[i].geometry.computeBoundingSphere()
      }
      // A line from the site to every satellite currently above the mask: when a ground sensor there could reach it.
      const up = sitePos && elevation(s, c.t, site) >= MASK
      linkPos.setXYZ(i * 2, ...(sitePos ?? v))
      linkPos.setXYZ(i * 2 + 1, ...(up ? v : (sitePos ?? v)))
    })
    linkPos.needsUpdate = true
    links.geometry.computeBoundingSphere()
  })

  const hover = (s: Sat) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const sub = subpoint(s, clock.current.t)
    if (sub) setReadout(`${s.name} · ${sub.alt.toFixed(0)} km up · inclination ${Number(s.omm.INCLINATION).toFixed(1)}° · over ${fmtLonLat(sub.lon, sub.lat)}`)
  }

  return (
    <>
      {sats.map((s, i) => (
        <mesh key={s.name} ref={(m) => void (markers.current[i] = m)} onPointerMove={hover(s)} onPointerOut={() => setReadout(null)}>
          <sphereGeometry args={[70, 12, 8]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      ))}
      {orbits.map((o, i) => <primitive key={i} object={o} raycast={() => null} />)}
      {labels.map((l, i) => <primitive key={i} object={l} />)}
      {site ? (
        <>
          <primitive object={links} raycast={() => null} />
          <mesh position={projectGlobe(site.lon, site.lat, -5)} raycast={() => null}>
            <sphereGeometry args={[45, 12, 8]} />
            <meshBasicMaterial color="#5598e7" />
          </mesh>
        </>
      ) : null}
    </>
  )
}

const fmtWhen = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtUtc = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC'

export function useSatellitesLayer(ctx: LayerContext): Layer {
  const feed = use(satelliteFeed())
  const sats = useMemo(() => track(feed), [feed])
  const [speedParam, setSpeed] = useUrlState('speed', 1)
  const speed = SPEEDS.includes(speedParam) ? speedParam : 1
  const clock = useRef<Clock>({ t: Date.now(), speed })
  clock.current.speed = speed

  // The panel reads the simulated clock four times a second; the scene reads it every frame.
  const [now, setNow] = useState(clock.current.t)
  useEffect(() => {
    const id = setInterval(() => setNow(clock.current.t), 250)
    return () => clearInterval(id)
  }, [])

  const site = ctx.focus && ctx.focus !== CONTINENT ? ctx.focus : null
  // Passes over 36 h of simulated time, recomputed when the site changes or 12 h have gone by, so the next 24 h are always covered.
  const [windowStart, setWindowStart] = useState(now)
  useEffect(() => setWindowStart(clock.current.t), [site])
  useEffect(() => {
    if (now > windowStart + DAY / 2 || now < windowStart) setWindowStart(now)
  }, [now, windowStart])
  const list = useMemo(() => (site ? passes(sats, site, windowStart, 36) : []), [sats, site, windowStart])
  const upcoming = list.filter((p) => p.los > now && p.aos < now + DAY)
  const cov = coverage(upcoming, now, now + DAY)

  return {
    id: 'sats',
    label: "Fleet's Centauri satellites",
    scene: <SatScene sats={sats} clock={clock} site={site} setReadout={ctx.setReadout} />,
    controls: (
      <>
        <div className="segmented" role="radiogroup" aria-label="Time speed">
          {SPEEDS.map((s) => (
            <label key={s}>
              <input type="radio" name="speed" checked={speed === s} onChange={() => setSpeed(s)} />
              {s === 1 ? 'Real time' : `${s}×`}
            </label>
          ))}
        </div>
        <div className="clock">
          <span className="data">
            {fmtWhen(now)} · {fmtUtc(now)}
          </span>
          <button onClick={() => ((clock.current.t = Date.now()), setNow(clock.current.t))}>Now</button>
        </div>
        <ul className="sat-list">
          {sats.map((s) => {
            const sub = subpoint(s, now)
            return (
              <li key={s.name}>
                <span>{s.name}</span>
                <span className="data">
                  {sub ? `${sub.alt.toFixed(0)} km` : '–'} · {Number(s.omm.INCLINATION).toFixed(1)}°
                </span>
              </li>
            )
          })}
        </ul>
        {site ? (
          <div className="passes">
            <p>
              <strong>Passes over {site.name}</strong> (above {MASK}°, your local time)
            </p>
            {cov.next ? (
              <p>
                {cov.next.aos <= now ? (
                  <>
                    <strong>{cov.next.sat} is overhead now</strong> until {fmtClock(cov.next.los)}.
                  </>
                ) : (
                  <>
                    Next: <strong>{cov.next.sat}</strong> in {fmtDuration(cov.next.aos - now)} ({fmtClock(cov.next.aos)}), for{' '}
                    {fmtDuration(cov.next.los - cov.next.aos)}, peaking at {cov.next.maxEl.toFixed(0)}°.
                  </>
                )}
              </p>
            ) : null}
            <p>
              {cov.count} passes in the next 24 h. Longest wait: {fmtDuration(cov.longest.to - cov.longest.from)} from{' '}
              {fmtClock(cov.longest.from)}.
            </p>
            <table className="pass-table">
              <tbody>
                {upcoming.slice(0, 6).map((p) => (
                  <tr key={p.sat + p.aos}>
                    <td className="data">{fmtClock(p.aos)}</td>
                    <td>{p.sat}</td>
                    <td className="data">{fmtDuration(p.los - p.aos)}</td>
                    <td className="data">{p.maxEl.toFixed(0)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">Choose a place in Go to and the blue line shows whenever a satellite is in reach of a ground sensor there.</p>
        )}
        <p className="hint">
          {sats.length} satellites listed in orbit by CelesTrak. Being in orbit doesn't confirm a satellite is still operating.
        </p>
      </>
    ),
    credit: (
      <>
        Orbits: CelesTrak GP data, fetched {new Date(feed.fetched).toISOString().slice(0, 16).replace('T', ' ')} UTC, propagated with SGP4
        (satellite.js)
      </>
    ),
  }
}
