import { use, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { load, type Grid, type Layer, type LayerContext } from '../layer'
import { R, projectGlobe } from '../project'

// Opaque inner sphere just below the deepest earthquakes (~690 km). It hides the far side of the globe, while the
// translucent shell above it lets earthquakes and slabs show through the surface.
export const CORE = R - 750

/** Polylines of [lon, lat] → line segments on the globe, `altitude` km above the surface. */
export function globeLines(lines: [number, number][][], altitude = 0) {
  const pts: number[] = []
  for (const line of lines)
    for (let i = 1; i < line.length; i++) pts.push(...projectGlobe(...line[i - 1], -altitude), ...projectGlobe(...line[i], -altitude))
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
}

const range = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

export function useGlobeLayer(ctx: LayerContext): Layer {
  const world = use(load<[number, number][][]>('/data/world-coast.json'))
  const g = use(load<Grid>('/data/vs.json'))
  const enter = useRef(ctx.enter)
  enter.current = ctx.enter

  const { coast, graticule, footprint, label } = useMemo(() => {
    const meridians = range(-180, 150, 30).map((lon) => range(-90, 90, 2).map((lat): [number, number] => [lon, lat]))
    const parallels = range(-60, 60, 30).map((lat) => range(-180, 180, 2).map((lon): [number, number] => [lon, lat]))
    const [w, e, s, n] = [g.lons[0], g.lons.at(-1)!, g.lats[0], g.lats.at(-1)!]
    const edge = (a: [number, number], b: [number, number]) => range(0, 1, 0.05).map((t): [number, number] => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    const ring = [edge([w, s], [e, s]), edge([e, s], [e, n]), edge([e, n], [w, n]), edge([w, n], [w, s])]

    const button = document.createElement('button')
    button.className = 'enter'
    button.textContent = 'Explore the crust in 3D'
    button.onclick = () => enter.current('australia')
    const label = new CSS2DObject(button)
    label.position.set(...projectGlobe((w + e) / 2, n, -40))

    // Surface layers sit a few km apart so the depth buffer can order them: shell 0, graticule 4, crust 8, coast 12, outline 15.
    return { coast: globeLines(world, 12), graticule: globeLines([...meridians, ...parallels], 4), footprint: globeLines(ring, 15), label }
  }, [world, g])

  return {
    id: 'earth',
    label: 'Earth',
    scene: (
      <>
        <mesh raycast={() => null}>
          <sphereGeometry args={[CORE, 96, 48]} />
          <meshBasicMaterial color="#121312" />
        </mesh>
        <mesh raycast={() => null}>
          <sphereGeometry args={[R, 128, 64]} />
          <meshBasicMaterial color="#2c3b45" transparent opacity={0.5} depthWrite={false} />
        </mesh>
        <lineSegments geometry={graticule} raycast={() => null}>
          <lineBasicMaterial color="#3d4440" />
        </lineSegments>
        <lineSegments geometry={coast} raycast={() => null}>
          <lineBasicMaterial color="#a9afa6" />
        </lineSegments>
        <lineSegments geometry={footprint} raycast={() => null}>
          <lineBasicMaterial color="#5598e7" />
        </lineSegments>
        <primitive object={label} />
      </>
    ),
    controls: <p className="hint">Blue outline: the area covered by the 3D crust model. Graticule every 30°.</p>,
    credit: <>Coastlines: Natural Earth (public domain)</>,
  }
}
