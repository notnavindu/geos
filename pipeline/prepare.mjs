// Raw sources → public/data/*.json: CSIRO Vs model, Natural Earth coastlines, USGS earthquakes,
// CelesTrak orbits for Fleet's Centauri satellites, CRUST1.0.
// Run: npm run data. Downloads into pipeline/raw/ if missing (delete a file to refresh it); every assert is the pipeline's test.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const RAW = new URL('./raw/', import.meta.url)
const OUT = new URL('../public/data/', import.meta.url)
const SOURCES = {
  'AU_tomo.Sv': 'https://data.csiro.au/dap/ws/v2/collections/58250/data/64692348',
  'layer_depth.txt': 'https://data.csiro.au/dap/ws/v2/collections/58250/data/64692347',
  'ne_50m_coastline.geojson':
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson',
  'ne_110m_coastline.geojson':
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson',
  // CelesTrak asks for at most one download per data update: this snapshot is only fetched when missing.
  'centauri.json': 'https://celestrak.org/NORAD/elements/gp.php?NAME=CENTAURI&FORMAT=json',
  'depthtomoho.xyz.zip': 'https://igppweb.ucsd.edu/~gabi/crust1/depthtomoho.xyz.zip',
  'crsthk.xyz.zip': 'https://igppweb.ucsd.edu/~gabi/crust1/crsthk.xyz.zip',
}

mkdirSync(RAW, { recursive: true })
mkdirSync(OUT, { recursive: true })
for (const [name, url] of Object.entries(SOURCES)) {
  if (existsSync(new URL(name, RAW))) continue
  console.log(`downloading ${name}`)
  const res = await fetch(url)
  assert.ok(res.ok, `${url}: HTTP ${res.status}`)
  writeFileSync(new URL(name, RAW), Buffer.from(await res.arrayBuffer()))
}
const read = (name) => readFileSync(new URL(name, RAW), 'utf8')
const statSyncMs = (name) => statSync(new URL(name, RAW)).mtimeMs

// --- velocity model -------------------------------------------------------
// readme.txt: NX=56 lon, NY=45 lat, NZ=31 depth, 0.75° spacing. Rows are "lon lat depth Vs",
// lon varying fastest, then lat (south → north), then depth.
const NX = 56, NY = 45, NZ = 31
const rows = read('AU_tomo.Sv').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
assert.equal(rows.length, NX * NY * NZ)

const lons = rows.slice(0, NX).map((r) => r[0])
const lats = Array.from({ length: NY }, (_, j) => rows[j * NX][1])
const depths = Array.from({ length: NZ }, (_, k) => rows[k * NX * NY][2])
rows.forEach(([lon, lat, depth, vs], n) => {
  const i = n % NX, j = Math.floor(n / NX) % NY, k = Math.floor(n / (NX * NY))
  assert.ok(lon === lons[i] && lat === lats[j] && depth === depths[k], `row ${n + 1} out of grid order`)
  assert.ok(vs > 1 && vs < 6, `row ${n + 1}: implausible Vs ${vs}`)
})
lons.forEach((lon, i) => assert.equal(lon, 113 + 0.75 * i))
lats.forEach((lat, j) => assert.equal(lat, -44 + 0.75 * j))
assert.deepEqual(depths, read('layer_depth.txt').trim().split('\n').map((l) => Number(l.trim().split(/\s+/)[1])))

writeFileSync(
  new URL('vs.json', OUT),
  JSON.stringify({
    name: 'Australian crust shear-wave velocity (ambient noise tomography)',
    units: 'km/s',
    citation:
      'Chen, Saygin, Kennett, Tork Qashqai, Hauser, Lumley & Sandiford (2021). Next-generation velocity model of the Australian crust from synchronous and asynchronous ambient noise imaging. v2. CSIRO. Data Collection.',
    credit: 'Chen et al. (2021), CSIRO',
    doi: 'https://doi.org/10.25919/p88f-vh04',
    license: 'CC BY-NC-SA 4.0',
    lons,
    lats,
    depths,
    // [depth][lat][lon], km/s rounded to 1 m/s (source is float32)
    values: rows.map((r) => Math.round(r[3] * 1000) / 1000),
  }),
)

// --- coastline, clipped to the model extent ---------------------------------
// ponytail: point-filter clip, so lines end at the last vertex inside the box rather than exactly on it
const inside = ([lon, lat]) => lon >= lons[0] && lon <= lons[NX - 1] && lat >= lats[0] && lat <= lats[NY - 1]
const lines = []
for (const { geometry: g } of JSON.parse(read('ne_50m_coastline.geojson')).features) {
  for (const coords of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
    let run = []
    for (const p of [...coords, null]) {
      if (p && inside(p)) run.push(p.map((c) => Math.round(c * 1000) / 1000))
      else (run.length > 1 && lines.push(run), (run = []))
    }
  }
}
assert.ok(lines.length > 0)
writeFileSync(new URL('coast.json', OUT), JSON.stringify(lines))

console.log(`vs.json: ${NX}×${NY}×${NZ} grid, depths ${depths[0]}–${depths[NZ - 1]} km`)
console.log(`coast.json: ${lines.length} polylines, ${lines.flat().length} points`)

// --- world coastline for the globe --------------------------------------------
const world = JSON.parse(read('ne_110m_coastline.geojson')).features.flatMap(({ geometry: g }) =>
  (g.type === 'LineString' ? [g.coordinates] : g.coordinates).map((line) => line.map((p) => p.map((c) => Math.round(c * 100) / 100))),
)
assert.ok(world.length > 100)
writeFileSync(new URL('world-coast.json', OUT), JSON.stringify(world))
console.log(`world-coast.json: ${world.length} polylines`)

// --- USGS earthquakes, M5+ since 2000 -------------------------------------------
// One request per year: the API caps a query at 20,000 events. Past years are cached; the current year is refetched.
const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1'
const thisYear = new Date().getUTCFullYear()
mkdirSync(new URL('usgs/', RAW), { recursive: true })
const quakes = []
for (let year = 2000; year <= thisYear; year++) {
  const file = new URL(`usgs/${year}.csv`, RAW)
  const params = `minmagnitude=5&eventtype=earthquake&starttime=${year}-01-01&endtime=${year + 1}-01-01`
  if (!existsSync(file) || year === thisYear) {
    const count = Number(await (await fetch(`${USGS}/count?${params}`)).text())
    const res = await fetch(`${USGS}/query?format=csv&orderby=time-asc&${params}`)
    assert.ok(res.ok, `USGS ${year}: HTTP ${res.status}`)
    const csv = await res.text()
    const n = csv.trim().split('\n').length - 1
    // Events can be added between the two requests for the current year, never removed for past ones.
    assert.ok(year === thisYear ? n >= count : n === count, `USGS ${year}: ${n} rows, count says ${count}`)
    writeFileSync(file, csv)
  }
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(header.startsWith('time,latitude,longitude,depth,mag,'), `USGS ${year}: unexpected columns`)
  for (const line of lines) {
    const [time, lat, lon, depth, mag] = line.split(',', 5) // first five columns are never quoted
    const q = [+(+lon).toFixed(3), +(+lat).toFixed(3), +(+depth).toFixed(1), +(+mag).toFixed(1), Math.floor(Date.parse(time) / 864e5)]
    assert.ok(Math.abs(q[0]) <= 180 && Math.abs(q[1]) <= 90 && q[2] >= -5 && q[2] <= 750 && q[3] >= 5 && q[4] > 10000, `bad row: ${line}`)
    quakes.push(q)
  }
}
writeFileSync(
  new URL('quakes.json', OUT),
  JSON.stringify({
    source: `USGS ComCat, M5+ earthquakes 2000–${thisYear}`,
    fetched: new Date().toISOString().slice(0, 10),
    fields: ['lon', 'lat', 'depth km', 'magnitude', 'days since 1970-01-01'],
    rows: quakes,
  }),
)
console.log(`quakes.json: ${quakes.length} earthquakes, deepest ${Math.max(...quakes.map((q) => q[2]))} km`)

// --- Fleet's Centauri satellites (OMM JSON from CelesTrak) ------------------------
// Bundled fallback for the Worker's /api/satellites, which refreshes from CelesTrak on a schedule in production.
const sats = JSON.parse(read('centauri.json'))
assert.ok(Array.isArray(sats) && sats.length > 0 && sats.every((s) => s.OBJECT_NAME.startsWith('CENTAURI') && s.MEAN_MOTION > 0))
writeFileSync(
  new URL('centauri.json', OUT),
  JSON.stringify({ source: 'CelesTrak GP data (OMM JSON), NAME=CENTAURI', fetched: new Date(statSyncMs('centauri.json')).toISOString(), satellites: sats }),
)
console.log(`centauri.json: ${sats.map((s) => s.OBJECT_NAME).join(', ')}`)

// --- CRUST1.0 (Laske et al. 2013), 1° global --------------------------------------
// Rows run lon -179.5 → 179.5 fastest, then lat 89.5 → -89.5. Moho depth is negative km relative to sea level.
const xyz = (zip) => execFileSync('unzip', ['-p', new URL(zip, RAW).pathname], { encoding: 'utf8', maxBuffer: 16e6 }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
const mohoRows = xyz('depthtomoho.xyz.zip'), thickRows = xyz('crsthk.xyz.zip')
for (const grid of [mohoRows, thickRows]) {
  assert.equal(grid.length, 360 * 180)
  grid.forEach(([lon, lat], n) => assert.ok(lon === -179.5 + (n % 360) && lat === 89.5 - Math.floor(n / 360), `CRUST1.0 row ${n + 1} out of order`))
}
writeFileSync(
  new URL('crust1.json', OUT),
  JSON.stringify({
    citation: 'Laske, Masters, Ma & Pasyanos (2013). Update on CRUST1.0: a 1-degree global model of Earth\'s crust. EGU General Assembly abstract EGU2013-2658.',
    url: 'https://igppweb.ucsd.edu/~gabi/crust1.html',
    grid: { lon0: -179.5, lat0: 89.5, step: 1, nlon: 360, nlat: 180 },
    moho: mohoRows.map((r) => +(-r[2]).toFixed(1)), // km below sea level, positive down
    thickness: thickRows.map((r) => +r[2].toFixed(1)), // km
  }),
)
console.log(`crust1.json: Moho ${Math.min(...mohoRows.map((r) => -r[2]))}–${Math.max(...mohoRows.map((r) => -r[2]))} km below sea level`)
