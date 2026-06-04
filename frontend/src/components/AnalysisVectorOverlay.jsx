function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

const VIRIDIS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
]

function interpolateStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t || 0))
  const pos = clamped * (stops.length - 1)
  const i = Math.floor(pos)
  const j = Math.min(i + 1, stops.length - 1)
  const f = pos - i
  const rgb = [
    lerp(stops[i][0], stops[j][0], f),
    lerp(stops[i][1], stops[j][1], f),
    lerp(stops[i][2], stops[j][2], f),
  ]
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

function hot(t) {
  const x = Math.max(0, Math.min(1, t || 0))
  let r = 0; let g = 0; let b = 0
  if (x < 1 / 3) r = 3 * x
  else if (x < 2 / 3) { r = 1; g = 3 * x - 1 }
  else { r = 1; g = 1; b = 3 * x - 2 }
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}

function extent(values) {
  const nums = values.filter(v => Number.isFinite(v))
  if (!nums.length) return [0, 1]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return max > min ? [min, max] : [min, min + 1]
}

function sample(items, limit) {
  if (!items || items.length <= limit) return items || []
  const step = Math.ceil(items.length / limit)
  return items.filter((_, index) => index % step === 0).slice(0, limit)
}

export default function AnalysisVectorOverlay({ imgMeta, thickness, processMetric, showThickness = true, showProcess = true }) {
  if (!imgMeta || (!thickness && !processMetric)) return null

  const points = showThickness ? sample(thickness?.points, 5000) : []
  const processPairs = processMetric?.areaPreview?.displayPairs
    || processMetric?.areaPreview?.pairs
    || processMetric?.displayPairs
    || processMetric?.pairs
  const pairs = showProcess ? sample(processPairs, 2000) : []
  const [tMin, tMax] = extent(points.map(p => p.value))
  const [pMin, pMax] = extent(pairs.map(p => p.distance))

  return (
    <svg
      width={imgMeta.width}
      height={imgMeta.height}
      viewBox={`0 0 ${imgMeta.width} ${imgMeta.height}`}
      style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {pairs.map((pair, index) => {
        const t = (pair.distance - pMin) / (pMax - pMin)
        return (
          <line
            key={`pair-${index}`}
            x1={pair.x0}
            y1={pair.y0}
            x2={pair.x1}
            y2={pair.y1}
            stroke={hot(t)}
            strokeWidth={2}
            opacity={0.9}
          />
        )
      })}
      {points.map((point, index) => {
        const t = (point.value - tMin) / (tMax - tMin)
        return (
          <circle
            key={`thick-${index}`}
            cx={point.x}
            cy={point.y}
            r={2}
            fill={interpolateStops(VIRIDIS, t)}
            opacity={0.9}
          />
        )
      })}
    </svg>
  )
}
