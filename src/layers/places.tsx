import { use, useMemo, useRef } from 'react'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Layer, LayerContext } from '../layer'
import { CONTINENT, PLACES } from '../places'
import { project } from '../project'
import { MASK, coverage, fmtClock, fmtDuration, passes, satelliteFeed, track } from '../sats'

/** Clickable surface labels for the places in the location switcher. Labels are DOM, drawn by App's <Labels>. */
export function usePlacesLayer(ctx: LayerContext): Layer {
  const setFocus = useRef(ctx.setFocus)
  setFocus.current = ctx.setFocus

  const labels = useMemo(
    () =>
      PLACES.map((p) => {
        const button = document.createElement('button')
        button.textContent = p.name
        button.title = `${p.name}: ${p.kind}. Click to fly here.`
        button.onclick = () => setFocus.current(p)
        const anchor = document.createElement('div')
        anchor.className = 'place'
        anchor.append(button)
        const label = new CSS2DObject(anchor)
        label.position.set(...project(p.lon, p.lat))
        return label
      }),
    [],
  )

  // Ties the two views together: when Fleet's satellites next pass over the place you're looking under.
  const feed = use(satelliteFeed())
  const sats = useMemo(() => track(feed), [feed])
  const place = ctx.focus && ctx.focus !== CONTINENT ? ctx.focus : null
  const next = useMemo(() => {
    if (!place) return null
    const now = Date.now()
    return coverage(passes(sats, place, now, 24), now, now + 24 * 3600e3)
  }, [sats, place])

  return {
    id: 'places',
    label: 'Places',
    scene: labels.map((l) => <primitive key={l.uuid} object={l} />),
    controls:
      place && next?.next ? (
        <p className="hint">
          Next Centauri pass over {place.name}: <strong>{next.next.sat}</strong>{' '}
          {next.next.aos <= Date.now() ? 'overhead now' : `in ${fmtDuration(next.next.aos - Date.now())} (${fmtClock(next.next.aos)})`}, peaking at{' '}
          {next.next.maxEl.toFixed(0)}°. {next.count} passes above {MASK}° in the next 24 h.
        </p>
      ) : (
        <p className="hint">Choose a place to see when Fleet's Centauri satellites next pass over it.</p>
      ),
  }
}
