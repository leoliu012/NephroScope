import { Fragment, useId } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  caseSections, densityCurve, distributionLayout, formatAxisValue, formatThickness, hasCaseSections, labelChars,
  middleEllipsis, niceScale, plotDomain, thicknessAxisTitle, wrapLabel,
} from '../thicknessStats.js'

const PALETTE = {
  dark: ['#63a4d8', '#6ee7b7', '#c4b5fd', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635'],
  light: ['#2563a6', '#0f8a62', '#6d4fc2', '#a86a12', '#c43d5c', '#0e7fb5', '#5f8f12'],
}
const INK = {
  dark: { text: 'var(--text)', muted: 'var(--text-muted)', subtle: 'var(--text-subtle)', grid: 'var(--border-strong)', minor: 'var(--border)', axis: 'var(--text-subtle)', band: 'var(--surface-2)', meanStroke: '#0b0e12' },
  light: { text: '#182230', muted: '#475467', subtle: '#667085', grid: '#d0d5dd', minor: '#eef0f3', axis: '#98a2b3', band: '#eef1f5', meanStroke: '#ffffff' },
}

function groupTitle(group) {
  if (group.title) return group.title
  if (!group.filename) return group.caseId
  return `${group.filename}${Number.isInteger(group.zIndex) ? ` · Z${group.zIndex + 1}` : ''}`
}

function groupSubtitle(group, { showCase }) {
  const parts = []
  if (showCase && group.filename && !group.title) parts.push(group.caseId)
  parts.push(`n = ${group.summary.count.toLocaleString()} points`)
  if (group.imageCount > 1 || !group.filename) parts.push(`${group.imageCount} image${group.imageCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function caseDetail(groups, pooled) {
  const images = new Set(groups.map(group => group.filename)).size
  const points = pooled?.summary.count ?? groups.reduce((sum, group) => sum + group.summary.count, 0)
  const slices = groups.length !== images ? ` · ${groups.length} Z slices` : ''
  return `${images} image${images === 1 ? '' : 's'}${slices} · n = ${points.toLocaleString()} points`
}

function densityPath(curve, x, baseline, height) {
  if (curve.length < 2) return ''
  const top = curve.map(([value, density]) => `${x(value).toFixed(1)},${(baseline - density * height).toFixed(1)}`)
  return `M${x(curve[0][0]).toFixed(1)},${baseline}L${top.join('L')}L${x(curve.at(-1)[0]).toFixed(1)},${baseline}Z`
}

function BoxMarks({ stats, x, cy, color, ink, size = 1 }) {
  const half = 7 * size
  const diamond = half + 0.5
  return <>
    <line x1={x(stats.low)} x2={x(stats.high)} y1={cy} y2={cy} stroke={color} strokeWidth="1.6" />
    {[stats.low, stats.high].map((value, i) => <line key={i} x1={x(value)} x2={x(value)} y1={cy - 5 * size} y2={cy + 5 * size} stroke={color} strokeWidth="1.6" />)}
    <rect x={x(stats.q1)} y={cy - half} width={Math.max(1.5, x(stats.q3) - x(stats.q1))} height={half * 2} rx="2.5" fill={color} fillOpacity="0.28" stroke={color} strokeWidth="1.6" />
    <line x1={x(stats.median)} x2={x(stats.median)} y1={cy - half} y2={cy + half} stroke={ink.text} strokeWidth="2" />
    <path d={`M${x(stats.mean)},${cy - diamond}L${x(stats.mean) + diamond},${cy}L${x(stats.mean)},${cy + diamond}L${x(stats.mean) - diamond},${cy}Z`} fill={color} stroke={ink.meanStroke} strokeWidth="1.5" />
  </>
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

const statText = (stats, unit) => ({
  mean: formatThickness(stats.mean, unit, { withUnit: false }),
  sd: formatThickness(stats.sd, unit, { withUnit: false }),
  median: formatThickness(stats.median, unit, { withUnit: false }),
  iqr: `${formatThickness(stats.q1, unit, { withUnit: false })}–${formatThickness(stats.q3, unit, { withUnit: false })}`,
  whiskers: `${formatThickness(stats.low, unit, { withUnit: false })}–${formatThickness(stats.high, unit, { withUnit: false })}`,
})

export default function ThicknessDistributionPlot({
  groups, unit, observed = false, focus = true, compact = false, chartOnly = false, theme = 'dark', domain,
  caseGroups = [], collapsedCases = {}, onToggleCase, linkFor,
}) {
  const clipId = useId().replace(/:/g, '')
  if (!groups.length) return <p className="ca-empty">Results appear here as Z slices finish. Empty masks add no measurements.</p>
  const ink = INK[theme] || INK.dark
  const colors = PALETTE[theme] || PALETTE.dark
  const cases = [...new Set(groups.map(group => group.caseId))]
  const colorForCase = caseId => colors[cases.indexOf(caseId) % colors.length]
  const pooledByCase = new Map(caseGroups.map(group => [group.caseId, group]))
  // Image- and slice-level comparisons get a (foldable) header per case.
  const sectioned = !compact && hasCaseSections(groups)
  const range = domain || plotDomain([...groups, ...(sectioned ? caseGroups : [])], focus)
  const scale = niceScale(range.min, range.max, compact ? 4 : 7)
  const collapsed = onToggleCase ? collapsedCases : {}
  const layout = distributionLayout(groups, { compact, collapsed })
  const { width, height, labelLeft, labelRight, plotLeft, plotRight, top, rowsBottom } = layout
  const labelWidth = labelRight - labelLeft
  const x = value => plotLeft + (plotRight - plotLeft) * (value - scale.min) / (scale.max - scale.min)
  const toggleKey = caseId => event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onToggleCase(caseId)
  }

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
        <text x={labelLeft} y={top - 8} fill={ink.subtle} fontSize="11" fontWeight="600">{sectioned ? 'Case / image' : 'Comparison group'}</text>
        <text x={width - 14} y={top - 8} fill={ink.subtle} fontSize="11" fontWeight="600" textAnchor="end">Mean ± SD</text>
      </>}

      {layout.rows.filter(row => row.type === 'case').map(row => <rect key={`band-${row.caseId}`} x={8} y={row.y + 3} width={width - 16} height={row.height - 6} rx="5" fill={ink.band} fillOpacity={theme === 'light' ? 1 : 0.85} />)}
      {scale.minorTicks.map(value => <line key={`minor-${value}`} x1={x(value)} x2={x(value)} y1={top} y2={rowsBottom} stroke={ink.minor} strokeOpacity={theme === 'light' ? 1 : 0.5} strokeWidth="1" />)}
      {scale.ticks.map(value => <line key={`major-${value}`} x1={x(value)} x2={x(value)} y1={top} y2={rowsBottom} stroke={ink.grid} strokeOpacity={theme === 'light' ? 1 : 0.7} strokeWidth="1" />)}

      {layout.rows.map((row, index) => {
        if (row.type === 'case') {
          const pooled = pooledByCase.get(row.caseId)
          const color = colorForCase(row.caseId)
          const cy = row.y + row.height / 2
          const interactive = Boolean(onToggleCase)
          return <g key={`case-${row.caseId}`} className={interactive ? 'ca-plot-case-toggle' : undefined}
            role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined}
            aria-expanded={interactive ? !row.folded : undefined}
            aria-label={interactive ? `${row.folded ? 'Expand' : 'Fold'} case ${row.caseId}` : undefined}
            onClick={interactive ? () => onToggleCase(row.caseId) : undefined}
            onKeyDown={interactive ? toggleKey(row.caseId) : undefined}>
            <rect x={8} y={row.y + 3} width={width - 16} height={row.height - 6} rx="5" fill="transparent" />
            {interactive && <path d={row.folded ? `M${labelLeft + 2},${cy - 4}l4,4l-4,4` : `M${labelLeft},${cy - 2}l4,4l4,-4`} fill="none" stroke={ink.muted} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
            <rect x={labelLeft + (interactive ? 15 : 0)} y={cy - 5} width="10" height="10" rx="2" fill={color} />
            <text x={labelLeft + (interactive ? 31 : 16)} y={cy + 4.5} fontSize="13">
              <tspan fill={ink.text} fontWeight="700">{middleEllipsis(row.caseId, 18)}</tspan>
              <tspan dx="10" fill={ink.subtle} fontSize="11">{caseDetail(row.groups, pooled)}</tspan>
            </text>
            {pooled && <>
              {row.folded && <g clipPath={`url(#${clipId})`}><BoxMarks stats={pooled.summary} x={x} cy={cy} color={color} ink={ink} size={0.75} /></g>}
              <text x={width - 14} y={cy + 4.5} fontSize="12" textAnchor="end">
                <tspan fill={ink.text} fontWeight="700">{formatThickness(pooled.summary.mean, unit, { withUnit: false })}</tspan>
                <tspan fill={ink.subtle} fontSize="10.5">{` ± ${formatThickness(pooled.summary.sd, unit, { withUnit: false })}`}</tspan>
              </text>
            </>}
          </g>
        }
        const { group } = row
        const stats = group.summary
        const rowTop = row.y
        const cy = rowTop + (compact ? 44 : 42)
        const color = colorForCase(group.caseId)
        const curve = densityCurve(group.values, group.counts, scale, compact ? 64 : 110, { spread: stats.q3 - stats.q1 })
        const indent = sectioned ? 12 : 0
        const titleLines = compact ? [] : wrapLabel(groupTitle(group), labelChars(labelWidth - indent, 12.5, true), 2)
        const titleY = titleLines.length > 1 ? [rowTop + 22, rowTop + 37] : [rowTop + 30]
        const subtitleY = titleLines.length > 1 ? rowTop + 53 : rowTop + 47
        const previous = layout.rows[index - 1]
        const href = !chartOnly && linkFor ? linkFor(group) : null
        const description = `${groupTitle(group)}: mean ${formatThickness(stats.mean, unit)} (SD ${formatThickness(stats.sd, unit)}), median ${formatThickness(stats.median, unit)}, IQR ${formatThickness(stats.q1, unit, { withUnit: false })}–${formatThickness(stats.q3, unit)}, ${stats.count.toLocaleString()} points`
        return <g key={group.key} role="img" aria-label={description}>
          <title>{description}</title>
          {previous?.type === 'group' && <line x1={compact ? 4 : 12} x2={width - (compact ? 4 : 12)} y1={rowTop} y2={rowTop} stroke={ink.grid} strokeOpacity="0.55" />}
          {compact ? <g clipPath={`url(#${clipId}-labels)`}>
            <text x={labelLeft} y={rowTop + 15} fill={ink.text} fontSize="11.5" fontWeight="600">{middleEllipsis(groupTitle(group), labelChars(labelWidth - 80, 11.5, true))}</text>
            <text x={width - 4} y={rowTop + 15} fill={ink.text} fontSize="11.5" fontWeight="700" textAnchor="end">{formatThickness(stats.mean, unit)}</text>
            <text x={labelLeft} y={rowTop + 27} fill={ink.subtle} fontSize="9.5">{`n = ${stats.count.toLocaleString()}`}</text>
            <text x={width - 4} y={rowTop + 27} fill={ink.subtle} fontSize="9.5" textAnchor="end">{`± ${formatThickness(stats.sd, unit, { withUnit: false })} SD`}</text>
          </g> : <>
            <g clipPath={`url(#${clipId}-labels)`}>
              {href
                ? <a href={href} className="ca-plot-link"><title>{`Open ${groupTitle(group)} in the viewer`}</title>
                  {/* The whole title block is clickable, not just the glyphs. */}
                  <rect x={labelLeft + indent} y={titleY[0] - 14} width={labelWidth - indent} height={titleY.at(-1) - titleY[0] + 19} fill="transparent" />
                  {titleLines.map((line, i) => <text key={i} x={labelLeft + indent} y={titleY[i]} fill={ink.text} fontSize="12.5" fontWeight="600">{line}</text>)}
                </a>
                : titleLines.map((line, i) => <text key={i} x={labelLeft + indent} y={titleY[i]} fill={ink.text} fontSize="12.5" fontWeight="600">{line}</text>)}
              <text x={labelLeft + indent} y={subtitleY} fill={ink.subtle} fontSize="10.5">{middleEllipsis(groupSubtitle(group, { showCase: !sectioned }), labelChars(labelWidth - indent, 10.5))}</text>
            </g>
            <text x={width - 14} y={cy + 1} fill={ink.text} fontSize="14" fontWeight="700" textAnchor="end">{formatThickness(stats.mean, unit, { withUnit: false })}</text>
            <text x={width - 14} y={cy + 15} fill={ink.subtle} fontSize="10.5" textAnchor="end">{`± ${formatThickness(stats.sd, unit, { withUnit: false })} ${unit}`}</text>
          </>}
          <g clipPath={`url(#${clipId})`}>
            <path d={densityPath(curve, x, cy - 9, compact ? 14 : 19)} fill={color} fillOpacity="0.22" stroke={color} strokeOpacity="0.55" strokeWidth="1" />
            <BoxMarks stats={stats} x={x} cy={cy} color={color} ink={ink} />
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

  const tableRow = (group, nested) => {
    const text = statText(group.summary, unit)
    const label = nested ? groupTitle(group) : group.label
    const href = linkFor ? linkFor(group) : null
    return <tr key={group.key} className={nested ? 'ca-table-nested' : undefined}>
      <th scope="row">{!nested && <span className="ca-table-swatch" style={{ background: colorForCase(group.caseId) }} />}{href
        ? <a className="ca-table-link" href={href} title="Open in the viewer">{label}</a>
        : label}</th>
      <td className="ca-table-mean">{text.mean} <span>± {text.sd}</span></td>
      <td>{text.median}</td><td>{text.iqr}</td><td>{text.whiskers}</td>
      <td>{group.summary.count.toLocaleString()}</td><td>{group.imageCount}</td><td>{group.runs}</td>
    </tr>
  }

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
          <th>{sectioned ? 'Case / image' : 'Comparison group'}</th><th>Mean ± SD ({unit})</th><th>Median</th><th>IQR (Q1–Q3)</th>
          <th>Whiskers</th><th>Points</th><th>Images</th><th>Z runs</th>
        </tr></thead>
        <tbody>{sectioned ? caseSections(groups).map(section => {
          const pooled = pooledByCase.get(section.caseId)
          const folded = Boolean(collapsed[section.caseId])
          const text = pooled ? statText(pooled.summary, unit) : null
          const swatch = <span className="ca-table-swatch" style={{ background: colorForCase(section.caseId) }} />
          return <Fragment key={section.caseId}>
            <tr className="ca-table-case">
              <th scope="rowgroup">
                {onToggleCase
                  ? <button type="button" aria-expanded={!folded} onClick={() => onToggleCase(section.caseId)}>
                    {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{swatch}{section.caseId}
                  </button>
                  : <>{swatch}{section.caseId}</>}
              </th>
              {text ? <>
                <td className="ca-table-mean">{text.mean} <span>± {text.sd}</span></td>
                <td>{text.median}</td><td>{text.iqr}</td><td>{text.whiskers}</td>
                <td>{pooled.summary.count.toLocaleString()}</td><td>{pooled.imageCount}</td><td>{pooled.runs}</td>
              </> : <td colSpan={7} />}
            </tr>
            {!folded && section.groups.map(group => tableRow(group, true))}
          </Fragment>
        }) : groups.map(group => tableRow(group, false))}</tbody>
      </table>
    </div>}
  </>
}
