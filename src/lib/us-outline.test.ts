import { describe, expect, it } from 'vitest'
import { isInUSOutline } from './us-outline'

const inside: [string, number, number][] = [
  ['Los Angeles', 34.05, -118.24],
  ['San Diego', 32.72, -117.16],
  ['El Paso', 31.8, -106.42],
  ['Brownsville', 25.93, -97.5],
  ['Big Bend', 29.25, -103.25],
  ['Miami', 25.76, -80.19],
  ['Key West', 24.56, -81.78],
  ['New York', 40.71, -74.0],
  ['Boston', 42.36, -71.06],
  ['Buffalo', 42.89, -78.88],
  ['Detroit', 42.36, -83.07],
  ['Chicago', 41.88, -87.63],
  ['Duluth', 46.79, -92.1],
  ['Seattle', 47.61, -122.33],
  ['Bellingham', 48.75, -122.48],
  ['Anchorage', 61.22, -149.9],
  ['Juneau', 58.3, -134.42],
  ['Honolulu', 21.31, -157.86],
]

const outside: [string, number, number][] = [
  ['Tijuana', 32.51, -117.0],
  ['Ciudad Juárez', 31.69, -106.42],
  ['Matamoros', 25.84, -97.52],
  ['Monterrey', 25.69, -100.32],
  ['Hermosillo', 29.07, -110.96],
  ['Toronto', 43.65, -79.38],
  ['Montreal', 45.5, -73.57],
  ['Vancouver', 49.28, -123.12],
  ['Winnipeg', 49.9, -97.14],
  ['Nassau', 25.05, -77.35],
  ['Havana', 23.11, -82.37],
  ['Whitehorse', 60.72, -135.06],
]

describe('isInUSOutline', () => {
  it.each(inside)('accepts %s', (_, lat, lng) => expect(isInUSOutline(lat, lng)).toBe(true))
  it.each(outside)('rejects %s', (_, lat, lng) => expect(isInUSOutline(lat, lng)).toBe(false))
})
