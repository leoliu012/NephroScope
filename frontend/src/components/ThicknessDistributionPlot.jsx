import { useId } from 'react'
import {
  PLOT_LAYOUT, densityCurve, distributionPlotSize, formatAxisValue, formatThickness, labelChars, middleEllipsis, niceScale,
  plotDomain, thicknessAxisTitle, wrapLabel,
} from '../thicknessStats.js'

const PALETTE = {
  dark: ['#63a4d8', '#6ee7b7', '#c4b5fd', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635'],
  light: ['#2563a6', '#0f8a62', '#6d4fc2', '#a86a12', '#c43d5c', '#0e7fb5', '#5f8f12'],
}
const INK = {
  dark: { text: 'var(--text)', muted: 'var(--text-muted)', subtle: 'var(--text-subtle)', grid: 'var(--border-strong)', minor: 'var(--border)', axis: 'var(--text-subtle)', meanStroke: '#0b0e12' },
  light: { text: '#182230', muted: '#475467', subtle: '#667085', grid: '#d0d5dd', minor: '#eef0f3', axis: '#98a2b3', meanStroke: '#ffffff' },
}

function groupTitle(group) {
  if (group.title) return group.title
  if (!group.filename) return group.caseId
  return `${group.filename}${Number.isInteger(group.zIndex) ? ` · Z${group.zIndex + 1}` : ''}`
}

function groupSubtitle(group) {
  const parts = []
  if (group.filename && !group.title) parts.push(group.caseId)
  parts.push(`n = ${group.summary.count.toLocaleString()} points`)
  if (group.imageCount > 1 || !group.filename) parts.push(`${group.imageCount} image${group.imageCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function densityPath(curve, x, baseline, height) {
  if (curve.length < 2) return ''
  const top = curve.map(([value, density]) => `${x(value).toFixed(1)},${(baseline - density * height).toFixed(1)}`)
  return `M${x(curve[0][0]).toFixed(1)},${baseline}L${top.join('L')}L${x(curve.at(-1)[0]).toFixed(1)},${baseline}Z`
}

function Legend({ x, y, ink, color, compact }) {
  const gap = compact ? 10 : 18
  const items = [
    ['mean', 'Mean'], ['median', 'Median'], ['box', 'IQR (25–75%)'], ['whisker', compact ? '1.5×IQR' : 'Whiskers (1.5 × IQR)'], ['density', 'Density'],
  ]
  let cursor = x
  return <g aria-hidden="true" fontSize={compact ? 9.5 : 11} fill={ink.muted}>
    {items.map(([kind, label]) => {
      const start = cursor
      const width = label.length * (compact ? 5.1 : 5.9) + 16
      cursor += width + gap
      return <g key={kind} transform={`translate(${start},${y})`}>
        {kind === 'mean' && <path d="M5,-5L10,0L5,5L0,0Z" fill={color} stroke={ink.meanStroke} strokeWidth="1" />}
        {kind === 'median' && <line x1="5" x2="5" y1="-6" y2="6" stroke={ink.text} strokeWidth="2" />}
        {kind === 'box' && <rect x="0" y="-5" width="11" height="10" rx="2" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.4" />}
        {kind === 'whisker' && <path d="M0,-4V4M0,0H11M11,-4V4" stroke={color} strokeWidth="1.4" fill="none" />}
        {kind === 'density' && <path d="M0,5C3,5 3,-5 6,-5S9,5 12,5Z" fill={color} fillOpacity="0.28" />}
        <text x="16" y="4">{label}</text>
      </g>
    })}
  </g>
}

export default function ThicknessDistributionPlot({
  groups, unit, observed = false, focus = true, compact = false, chartOnly = false, theme = 'dark', domain,
}) {
  const clipId = useId().replace(/:/g, '')
  if (!groups.length) return <p className="ca-empty">Results appear here as Z slices finish. Empty masks add no measurements.</p>
  const ink = INK[theme] || INK.dark
  const colors = PALETTE[theme] || PALETTE.dark
  const cases = [...new Set(groups.map(group => group.caseId))]
  const colorFor = group => colors[cases.indexOf(group.caseId) % colors.length]
  const range = domain || plotDomain(groups, focus)
  const scale = niceScale(range.min, range.max, compact ? 4 : 7)

  const { width, labelLeft, labelRight, plotLeft, plotRight, rowHeight, top } = compact ? PLOT_LAYOUT.compact : PLOT_LAYOUT.full
  const labelWidth = labelRight - labelLeft
  const rowsBottom = top + groups.length * rowHeight
  const { height } = distributionPlotSize(groups.length, compact)
  const x = value => plotLeft + (plotRight - plotLeft) * (value - scale.min) / (scale.max - scale.min)

  const chart = (
    <svg xmlns="http://www.w3.org/2000/svg" width={chartOnly ? width : undefined} height={chartOnly ? height : undefined}
      fontFamily="Arial, Helvetica, sans-serif" className={`ca-distribution-plot${compact ? ' ca-distribution-compact' : ''}`}
      viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`GBM thickness distributions in ${unit}`}>
      <title>GBM thickness distributions: mean, median, interquartile range and density</title>
      <defs>
        <clipPath id={clipId}><rect x={plotLeft} y={top - 4} width={plotRight - plotLeft} height={rowsBottom - top + 8} /></clipPath>
        <clipPath id={`${clipId}-labels`}><rect x={0} y={top} width={compact ? width : labelRight} height={rowsBottom - top} /></clipPath>
      </defs>
      <Legend x={compact ? 4 : plotLeft} y={14} ink={ink} color={colors[0]} compact={compact} />
      {!compact && <>
        <text x={labelLeft} y={top - 8} fill={ink.subtle} fontSize="11" fontWeight="600">Comparison group</text>
        <text x={width - 14} y={top - 8} fill={ink.subtle} fontSize="11" fontWeight="600" textAnchor="end">Mean ± SD</text>
      </>}

      {scale.minorTicks.map(value => <line key={`minor-${value}`} x1={x(value)} x2={x(value)} y1={top} y2={rowsBottom} stroke={ink.minor} strokeOpacity={theme === 'light' ? 1 : 0.5} strokeWidth="1" />)}
      {scale.ticks.map(value => <line key={`major-${value}`} x1={x(value)} x2={x(value)} y1={top} y2={rowsBottom} stroke={ink.grid} strokeOpacity={theme === 'light' ? 1 : 0.7} strokeWidth="1" />)}

      {groups.map((group, index) => {
        const stats = group.summary
        const rowTop = top + index * rowHeight
        const cy = rowTop + (compact ? 44 : 42)
        const titleLines = compact ? [] : wrapLabel(groupTitle(group), labelChars(labelWidth, 12.5, true), 2)
        const titleY = titleLines.length > 1 ? [rowTop + 22, rowTop + 37] : [rowTop + 30]
        const subtitleY = titleLines.length > 1 ? rowTop + 53 : rowTop + 47
        const color = colorFor(group)
        const curve = densityCurve(group.values, group.counts, scale, compact ? 64 : 110, { spread: stats.q3 - stats.q1 })
        const description = `${groupTitle(group)}: mean ${formatThickness(stats.mean, unit)} (SD ${formatThickness(stats.sd, unit)}), median ${formatThickness(stats.median, unit)}, IQR ${formatThickness(stats.q1, unit, { withUnit: false })}–${formatThickness(stats.q3, unit)}, ${stats.count.toLocaleString()} points`
        return <g key={group.key} role="img" aria-label={description}>
          <title>{description}</title>
          {index > 0 && <line x1={compact ? 4 : 12} x2={width - (compact ? 4 : 12)} y1={rowTop} y2={rowTop} stroke={ink.grid} strokeOpacity="0.55" />}
          {compact ? <g clipPath={`url(#${clipId}-labels)`}>
            <text x={labelLeft} y={rowTop + 15} fill={ink.text} fontSize="11.5" fontWeight="600">{middleEllipsis(groupTitle(group), labelChars(labelWidth - 80, 11.5, true))}</text>
            <text x={width - 4} y={rowTop + 15} fill={ink.text} fontSize="11.5" fontWeight="700" textAnchor="end">{formatThickness(stats.mean, unit)}</text>
            <text x={labelLeft} y={rowTop + 27} fill={ink.subtle} fontSize="9.5">{`n = ${stats.count.toLocaleString()}`}</text>
            <text x={width - 4} y={rowTop + 27} fill={ink.subtle} fontSize="9.5" textAnchor="end">{`± ${formatThickness(stats.sd, unit, { withUnit: false })} SD`}</text>
          </g> : <>
            <g clipPath={`url(#${clipId}-labels)`}>
              {titleLines.map((line, i) => <text key={i} x={labelLeft} y={titleY[i]} fill={ink.text} fontSize="12.5" fontWeight="600">{line}</text>)}
              <text x={labelLeft} y={subtitleY} fill={ink.subtle} fontSize="10.5">{middleEllipsis(groupSubtitle(group), labelChars(labelWidth, 10.5))}</text>
            </g>
            <text x={width - 14} y={cy + 1} fill={ink.text} fontSize="14" fontWeight="700" textAnchor="end">{formatThickness(stats.mean, unit, { withUnit: false })}</text>
            <text x={width - 14} y={cy + 15} fill={ink.subtle} fontSize="10.5" textAnchor="end">{`± ${formatThickness(stats.sd, unit, { withUnit: false })} ${unit}`}</text>
          </>}
          <g clipPath={`url(#${clipId})`}>
            <path d={densityPath(curve, x, cy - 9, compact ? 14 : 19)} fill={color} fillOpacity="0.22" stroke={color} strokeOpacity="0.55" strokeWidth="1" />
            <line x1={x(stats.low)} x2={x(stats.high)} y1={cy} y2={cy} stroke={color} strokeWidth="1.6" />
            {[stats.low, stats.high].map((value, i) => <line key={i} x1={x(value)} x2={x(value)} y1={cy - 5} y2={cy + 5} stroke={color} strokeWidth="1.6" />)}
            <rect x={x(stats.q1)} y={cy - 7} width={Math.max(1.5, x(stats.q3) - x(stats.q1))} height="14" rx="2.5" fill={color} fillOpacity="0.28" stroke={color} strokeWidth="1.6" />
            <line x1={x(stats.median)} x2={x(stats.median)} y1={cy - 7} y2={cy + 7} stroke={ink.text} strokeWidth="2" />
            <path d={`M${x(stats.mean)},${cy - 7.5}L${x(stats.mean) + 7.5},${cy}L${x(stats.mean)},${cy + 7.5}L${x(stats.mean) - 7.5},${cy}Z`} fill={color} stroke={ink.meanStroke} strokeWidth="1.5" />
          </g>
        </g>
      })}

      <line x1={plotLeft} x2={plotRight} y1={rowsBottom} y2={rowsBottom} stroke={ink.axis} />
      {scale.minorTicks.map(value => <line key={`mt-${value}`} x1={x(value)} x2={x(value)} y1={rowsBottom} y2={rowsBottom + 3} stroke={ink.axis} />)}
      {scale.ticks.map(value => <g key={`t-${value}`}>
        <line x1={x(value)} x2={x(value)} y1={rowsBottom} y2={rowsBottom + 6} stroke={ink.axis} />
        <text x={x(value)} y={rowsBottom + 19} fill={ink.muted} fontSize={compact ? 10 : 11} textAnchor="middle">{formatAxisValue(value, scale.decimals)}</text>
      </g>)}
      <text x={(plotLeft + plotRight) / 2} y={rowsBottom + (compact ? 38 : 42)} fill={ink.text} fontSize={compact ? 10.5 : 12} fontWeight="600" textAnchor="middle">{thicknessAxisTitle(unit, observed)}</text>
      <text x={(plotLeft + plotRight) / 2} y={rowsBottom + (compact ? 51 : 56)} fill={ink.subtle} fontSize={compact ? 9 : 10} textAnchor="middle">
        {`Major grid every ${formatAxisValue(scale.step, scale.decimals)} ${unit}${focus ? ' · axis spans the whiskers' : ''}`}
      </text>
    </svg>
  )
  if (chartOnly) return chart
  return <>
    <div className="ca-plot-scroll">{chart}</div>
    {compact ? <div className="ta-statistics">{groups.map(group => <section key={group.key}>
      <h4>{groupTitle(group)}</h4>
      <p className="ta-stat-mean">{formatThickness(group.summary.mean, unit)}<span> mean ± {formatThickness(group.summary.sd, unit)} SD</span></p>
      <dl>{[
        ['Median', formatThickness(group.summary.median, unit)],
        ['IQR', `${formatThickness(group.summary.q1, unit, { withUnit: false })}–${formatThickness(group.summary.q3, unit)}`],
        ['Whiskers', `${formatThickness(group.summary.low, unit, { withUnit: false })}–${formatThickness(group.summary.high, unit)}`],
        ['Points', group.summary.count.toLocaleString()],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>)}</div> : <div className="ca-table-scroll">
      <table className="ca-table" aria-label={`GBM thickness statistics in ${unit}`}>
        <thead><tr>
          <th>Comparison group</th><th>Mean ± SD ({unit})</th><th>Median</th><th>IQR (Q1–Q3)</th>
          <th>Whiskers</th><th>Points</th><th>Images</th><th>Z runs</th>
        </tr></thead>
        <tbody>{groups.map(group => <tr key={group.key}>
          <th scope="row"><span className="ca-table-swatch" style={{ background: colorFor(group) }} />{group.label}</th>
          <td className="ca-table-mean">{formatThickness(group.summary.mean, unit, { withUnit: false })} <span>± {formatThickness(group.summary.sd, unit, { withUnit: false })}</span></td>
          <td>{formatThickness(group.summary.median, unit, { withUnit: false })}</td>
          <td>{formatThickness(group.summary.q1, unit, { withUnit: false })}–{formatThickness(group.summary.q3, unit, { withUnit: false })}</td>
          <td>{formatThickness(group.summary.low, unit, { withUnit: false })}–{formatThickness(group.summary.high, unit, { withUnit: false })}</td>
          <td>{group.summary.count.toLocaleString()}</td>
          <td>{group.imageCount}</td>
          <td>{group.runs}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>
}
