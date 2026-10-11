/**
 * Coarse US outline for deciding whether a visitor's location is in the US.
 *
 * `isInUS` in us-geo.ts is a bounding-box first reject: it also accepts
 * northern Mexico, southern Ontario/Quebec, and the Bahamas. These polygons
 * follow the land borders closely enough to reject those (to within a few
 * kilometres) and run well offshore along coasts, so coastal points pass.
 * Vertices are [longitude, latitude].
 */

type Ring = [number, number][]

const CONTIGUOUS: Ring = [
  // Canadian border, west to east
  [-124.8, 48.5], [-123.2, 48.2], [-123.0, 48.8], [-123.3, 49.0], [-95.15, 49.0],
  [-95.15, 49.38], [-94.8, 49.3], [-94.6, 48.7], [-93.2, 48.6], [-91.4, 48.05],
  [-89.6, 48.0], [-88.4, 48.3], [-84.8, 46.9], [-84.1, 46.5], [-83.5, 46.0],
  [-82.4, 45.3], [-82.1, 43.0], [-82.5, 42.6], [-83.1, 42.3], [-83.2, 41.9],
  [-81.0, 42.2], [-79.0, 42.9], [-79.0, 43.3], [-76.5, 43.6], [-76.2, 44.2],
  [-75.0, 44.95], [-71.5, 45.0], [-71.1, 45.3], [-70.6, 45.6], [-70.0, 46.7],
  [-69.2, 47.45], [-68.2, 47.35], [-67.8, 47.07], [-67.8, 45.7], [-67.4, 45.2],
  [-66.95, 44.8],
  // Atlantic, offshore
  [-67.0, 44.3], [-69.7, 41.0], [-72.5, 40.5], [-74.5, 38.7], [-75.2, 35.2],
  [-77.7, 33.6], [-79.5, 32.3], [-80.6, 31.0], [-80.9, 30.0], [-79.9, 27.0],
  [-79.95, 25.8], [-80.1, 25.0], [-80.4, 24.4], [-82.2, 24.3], [-83.1, 24.4],
  // Gulf of Mexico, offshore
  [-83.1, 24.8], [-83.0, 27.0], [-84.5, 29.5], [-86.0, 29.9], [-88.0, 30.0],
  [-89.4, 28.8], [-91.0, 28.9], [-93.5, 29.5], [-94.7, 29.0], [-96.5, 27.8],
  [-97.0, 25.95],
  // Mexican border, east to west (Rio Grande, then the land boundary)
  [-97.15, 25.95], [-97.45, 25.85], [-97.7, 25.95], [-98.3, 26.07], [-99.1, 26.4],
  [-99.5, 27.3], [-100.3, 28.2],
  [-100.9, 29.4], [-101.4, 29.75], [-102.4, 29.8], [-103.0, 29.0], [-103.6, 29.15],
  [-104.5, 29.6], [-105.0, 30.7], [-105.85, 31.29], [-106.16, 31.47], [-106.3, 31.63],
  [-106.45, 31.74], [-106.53, 31.784], [-108.2, 31.784],
  [-108.2, 31.33], [-111.07, 31.33], [-114.8, 32.49], [-114.72, 32.72], [-117.12, 32.53],
  // Pacific, offshore
  [-118.0, 32.53], [-121.0, 33.0], [-125.0, 40.0], [-125.0, 48.5],
]

const ALASKA: Ring = [
  [-141.0, 72.0], [-141.0, 60.3], [-139.1, 60.35], [-137.5, 59.0], [-135.5, 59.8],
  [-133.4, 58.4], [-131.8, 56.6], [-130.0, 55.9], [-130.6, 54.7], [-133.5, 54.5],
  [-150.0, 55.0], [-165.0, 51.5], [-180.0, 51.2], [-180.0, 62.0], [-168.9, 65.5],
  [-168.9, 72.0],
]

const HAWAII: Ring = [
  [-160.5, 18.7], [-154.6, 18.7], [-154.6, 22.4], [-160.5, 22.4],
]

const RINGS = [CONTIGUOUS, ALASKA, HAWAII]

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** True when the point falls inside the coarse US outline. */
export function isInUSOutline(latitude: number, longitude: number): boolean {
  return RINGS.some((ring) => inRing(longitude, latitude, ring))
}
