function extent(values) {
  const finite = (values || []).filter(value => Number.isFinite(value))
  if (!finite.length) return null
  return [Math.min(...finite), Math.max(...finite)]
}

function fmt(value) {
  if (!Number.isFinite(value)) return 'n/a'
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.001) return value.toExponential(2)
  return value.toFixed(3)
}

function Scale({ label, unit, range, className }) {
  if (!range) return null
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 text-[10px] text-gray-200">
        <span>{label}</span>
        <span className="text-gray-400">{unit}</span>
      </div>
      <div className={`analysis-color-scale ${className}`} />
      <div className="flex justify-between font-mono text-[9px] text-gray-400">
        <span>{fmt(range[0])}</span>
        <span>{fmt(range[1])}</span>
      </div>
    </div>
  )
}

export default function AnalysisLegend({
  thickness,
  processMetric,
  showThickness = true,
  showProcess = true,
}) {
  if ((!thickness || !showThickness) && (!processMetric || !showProcess)) return null

  const thicknessExtent = extent(thickness?.points?.map(point => point.value))
  const processExtent = extent(processMetric?.pairs?.map(pair => pair.distance))
  const unit = thickness?.unit || processMetric?.unit || 'um'

  return (
    <div className="analysis-legend pointer-events-none absolute bottom-4 right-4 z-30 w-56 space-y-3 rounded-md border border-white/10 bg-black/75 p-3 shadow-xl">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-300">Analysis legend</p>
      {showThickness && <Scale label="GBM thickness" unit={unit} range={thicknessExtent} className="analysis-scale-viridis" />}
      {showProcess && <Scale label="Process NND" unit={unit} range={processExtent} className="analysis-scale-hot" />}
      {processMetric && showProcess && (
        <div className="space-y-1 border-t border-white/10 pt-2 text-[9px] text-gray-300">
          <p><span className="mr-2 inline-block h-0.5 w-4 bg-yellow-300 align-middle" />Original boundary</p>
          <p><span className="mr-2 inline-block h-0.5 w-4 bg-cyan-300 align-middle" />Watershed split boundary</p>
        </div>
      )}
    </div>
  )
}
