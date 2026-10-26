// Serves the built site plus GET /api/satellites. A cron trigger copies Fleet's Centauri orbits from CelesTrak into KV,
// so visitors never contact CelesTrak: it allows one download per data update per user and firewalls repeated errors.

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php?NAME=CENTAURI&FORMAT=json'
const KEY = 'centauri'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/satellites') {
      const cached = await env.ORBITS.get(KEY)
      if (cached) return new Response(cached, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=900' } })
      // Nothing in KV yet (first deploy, before the cron has run): serve the snapshot bundled at build time.
      return env.ASSETS.fetch(new URL('/data/centauri.json', url))
    }
    return env.ASSETS.fetch(request)
  },

  async scheduled(_controller, env) {
    const res = await fetch(CELESTRAK, { headers: { 'user-agent': 'geos crust viewer (portfolio project)' } })
    // 403 means "not updated since your last download". Keep the cached copy and wait for the next run; never retry here.
    if (!res.ok) return console.log(`CelesTrak HTTP ${res.status}; keeping the cached copy`)
    const satellites = await res.json<{ OBJECT_NAME?: string; MEAN_MOTION?: number }[]>()
    const valid = Array.isArray(satellites) && satellites.length > 0 && satellites.every((s) => s.OBJECT_NAME?.startsWith('CENTAURI') && Number(s.MEAN_MOTION) > 0)
    if (!valid) return console.log('CelesTrak returned unexpected data; keeping the cached copy')
    await env.ORBITS.put(KEY, JSON.stringify({ source: 'CelesTrak GP data (OMM JSON), NAME=CENTAURI', fetched: new Date().toISOString(), satellites }))
    console.log(`Cached ${satellites.length} Centauri element sets`)
  },
} satisfies ExportedHandler<Env>
