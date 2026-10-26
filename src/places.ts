export type Place = { name: string; kind?: string; lon: number; lat: number }

export const CONTINENT: Place = { name: 'Whole continent', lon: 134, lat: -26 }

// Mineral districts and basins. Model nodes are 0.75° (~80 km) apart, so these mark regions, not individual deposits.
export const PLACES: Place[] = [
  { name: 'Olympic Dam', kind: 'copper, uranium, gold · SA', lon: 136.88, lat: -30.44 },
  { name: 'Broken Hill', kind: 'lead, zinc, silver · NSW', lon: 141.47, lat: -31.95 },
  { name: 'Mount Isa', kind: 'copper, lead, zinc · QLD', lon: 139.49, lat: -20.73 },
  { name: 'Cooper Basin', kind: 'gas, sedimentary basin · SA', lon: 140.2, lat: -28.11 },
  { name: 'Kalgoorlie', kind: 'gold, nickel · Yilgarn Craton, WA', lon: 121.47, lat: -30.75 },
  { name: 'Greenbushes', kind: 'lithium · WA', lon: 116.06, lat: -33.86 },
  { name: 'Pilgangoora', kind: 'lithium · Pilbara Craton, WA', lon: 118.9, lat: -21.07 },
]
