import * as THREE from 'three'

// Validated with the dataviz skill's palette checker against the #1a1a19 surface (ordinal: monotone L, ΔL ≥ 0.06, ends ≥ 2:1).
// Diverging, seismology convention: red = slower, neutral = depth average, blue = faster.
export const DIVERGING = ['#b13f38', '#dd7167', '#f0aea6', '#f0efec', '#9ec5f4', '#5598e7', '#256abf']
// Sequential single hue for absolute velocity: lighter = slower.
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf']

// Second sequential context (depth of the velocity surface) takes its own hue, so it never reads as velocity.
export const DEPTH = ['#fdddc9', '#fdb584', '#fa8927', '#d76f04', '#af5b0b'] // shallow → deep

/** t ∈ [0, 1] → colour along the stops, interpolated in sRGB so it matches the CSS gradient. Components are raw sRGB 0–1. */
export function ramp(stops: string[]) {
  const colors = stops.map((s) => new THREE.Color().setStyle(s, THREE.NoColorSpace))
  const out = new THREE.Color()
  return (t: number) => {
    const x = Math.min(1, Math.max(0, t)) * (colors.length - 1)
    const k = Math.min(Math.floor(x), colors.length - 2)
    return out.copy(colors[k]).lerp(colors[k + 1], x - k)
  }
}

/** 256-texel lookup texture for the slice shader (sampled raw, so no colour-space conversion). */
export function lut(stops: string[]) {
  const at = ramp(stops)
  const data = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const c = at(i / 255)
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4)
  }
  const tex = new THREE.DataTexture(data, 256, 1)
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

export const gradient = (stops: string[]) => `linear-gradient(to right, ${stops.join(', ')})`
