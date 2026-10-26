import { use, useMemo } from 'react'
import * as THREE from 'three'
import { load, type Layer } from '../layer'
import { project } from '../project'

export function useCoastlineLayer(): Layer {
  const lines = use(load<[number, number][][]>('/data/coast.json'))
  const geometry = useMemo(() => {
    const pts: number[] = []
    for (const line of lines)
      for (let i = 1; i < line.length; i++) pts.push(...project(...line[i - 1]), ...project(...line[i]))
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  }, [lines])

  return {
    id: 'coast',
    label: 'Coastline',
    scene: (
      <lineSegments geometry={geometry} raycast={() => null}>
        <lineBasicMaterial color="#0b0b0b" />
      </lineSegments>
    ),
    credit: <>Coastline: Natural Earth (public domain)</>,
  }
}
