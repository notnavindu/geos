import { useEffect, useState } from 'react'

// View state lives in the URL hash so any view can be shared as a link. Values equal to the default are left out.
const params = new URLSearchParams(location.hash.slice(1))

export const getParam = (key: string) => params.get(key)

export function setParam(key: string, value: string | null) {
  if (value === null) params.delete(key)
  else params.set(key, value)
  // Hand-built so commas stay readable in shared links (URLSearchParams would write %2C).
  const hash = Array.from(params, ([k, v]) => `${k}=${encodeURIComponent(v).replaceAll('%2C', ',')}`).join('&')
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search)
}

/** useState mirrored to one URL hash key. Callers still validate: the URL is user input. */
export function useUrlState(key: string, initial: number): readonly [number, (v: number) => void]
export function useUrlState(key: string, initial: string): readonly [string, (v: string) => void]
export function useUrlState(key: string, initial: number | string): readonly [number | string, (v: never) => void] {
  const [value, setValue] = useState<number | string>(() => {
    const raw = params.get(key)
    if (raw === null || typeof initial === 'string') return raw ?? initial
    return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : initial
  })
  useEffect(() => setParam(key, value === initial ? null : String(value)), [key, value, initial])
  return [value, setValue] as const
}
