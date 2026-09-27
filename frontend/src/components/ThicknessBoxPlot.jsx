import { useId } from 'react'
import { representativeSamples } from '../caseAnalysis.js'

const COLORS = ['#63a4d8', '#6ee7b7', '#c4b5fd', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635']
const number = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })

export default function ThicknessBoxPlot({ groups, unit, focus, showPoints, compact = false, chartOnly = false, theme = 'dark', axisMaximum }) {
  const clipId = useId().replace(/:/g, '')
  if (!groups.length) return <p className="ca-empty">Thickness distributions will appear as selected runs finish. Empty masks contribute no samples.</p>
  const cases = [...new Set(groups.map(group => group.caseId))]
  const height = compact ? 62 + groups.length * 108 : 74 + groups.length * 78
  const width = compact ? 320 : 980
  const left = compact ? 22 : 250, right = compact ? 298 : 952, top = 34
  const ink = theme === 'light'
    ? { text: '#182230', muted: '#475467', subtle: '#667085', border: '#e4e7ec' }
    : { text: 'var(--text)', muted: 'var(--text-muted)', subtle: 'var(--text-subtle)', border: 'var(--border)' }
  const maximum = Math.max(axisMaximum ?? Math.max(...groups.map(group => focus ? group.summary.high : group.summary.max)), 0.001) * 1.06
  const x = value => left + (right - left) * value / maximum
  const chart = (
        <svg xmlns="http://www.w3.org/2000/svg" width={chartOnly ? width : undefined} height={chartOnly ? height : undefined} fontFamily="Arial, sans-serif" className={`ca-box-plot${compact ? ' ta-compact-plot' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`GBM thickness distributions in ${unit}`}>
          <title>GBM thickness comparison using every measured centerline point</title>
          <desc>Boxes span the 25th to 75th percentiles, with median lines and whiskers to the furthest sample within 1.5 times the interquartile range. Dots are a representative subset; statistics use every sample.</desc>
          <defs><clipPath id={clipId}><rect x={left} y={top} width={right - left} height={height - top} /></clipPath></defs>
          {Array.from({ length: compact ? 4 : 6 }, (_, index) => {
            const value = maximum * index / (compact ? 3 : 5)
            return <g key={index}>
              <line x1={x(value)} x2={x(value)} y1={top} y2={height - 28} stroke={ink.border} />
              <text x={x(value)} y={22} textAnchor="middle" fill={ink.muted} fontSize="11">{number(value)}</text>
            </g>
          })}
          <text x={(left + right) / 2} y={height - 5} textAnchor="middle" fill={ink.muted} fontSize="12">GBM thickness ({unit})</text>
          {groups.map((group, groupIndex) => {
            const y = compact ? 90 + groupIndex * 108 : 70 + groupIndex * 78
            const color = theme === 'light' ? '#27648b' : COLORS[cases.indexOf(group.caseId) % COLORS.length]
            const stats = group.summary
            const points = showPoints ? representativeSamples(group.values, group.counts) : []
            const description = `${group.label}: ${stats.count.toLocaleString()} samples, median ${number(stats.median)} ${unit}, Q1 ${number(stats.q1)}, Q3 ${number(stats.q3)}, ${stats.outliers.toLocaleString()} outliers`
            return <g key={group.key} tabIndex={0} role="img" aria-label={description}>
              <title>{description}</title>
              <text x={compact ? left : 12} y={y - (compact ? 27 : 7)} fill={ink.text} fontSize="12">{group.label.length > 32 ? `${group.label.slice(0, 30)}…` : group.label}</text>
              {!compact && <text x={12} y={y + 12} fill={ink.subtle} fontSize="10">{stats.count.toLocaleString()} points · {group.imageCount} images · {group.runs} Z runs</text>}
              <g clipPath={`url(#${clipId})`}>
                {points.map((value, index) => {
                  return <circle key={index} cx={x(value)} cy={y + 24 + ((index * 0.61803398875) % 1) * 14} r="1.7" fill={color} opacity="0.38" />
                })}
                <line x1={x(stats.low)} x2={x(stats.high)} y1={y} y2={y} stroke={color} strokeWidth="2" />
                {[stats.low, stats.high].map((value, index) => <line key={index} x1={x(value)} x2={x(value)} y1={y - 10} y2={y + 10} stroke={color} strokeWidth="2" />)}
                <rect x={x(stats.q1)} y={y - 16} width={Math.max(1, x(stats.q3) - x(stats.q1))} height="32" fill={color} fillOpacity="0.22" stroke={color} strokeWidth="2" rx="3" />
                <line x1={x(stats.median)} x2={x(stats.median)} y1={y - 16} y2={y + 16} stroke={ink.text} strokeWidth="2.5" />
              </g>
            </g>
          })}
        </svg>
  )
  if (chartOnly) return chart
  return (
    <>
      <div className="ca-plot-scroll">{chart}</div>
      <p className="ca-help">Box: middle 50% · line: median · whiskers: 1.5 × IQR. {showPoints && 'Dots show up to 120 representative points per group; every point contributes to the statistics. '}{focus && 'The axis focuses on the whiskers; outlier counts remain in the statistics.'}</p>
      {compact ? <div className="ta-statistics">{groups.map(group => <section key={group.key}>
        <h4>{group.label}</h4>
        <dl>{[
          ['Points', group.summary.count.toLocaleString()], ['Median', `${number(group.summary.median)} ${unit}`],
          ['Q1 (25%)', `${number(group.summary.q1)} ${unit}`], ['Q3 (75%)', `${number(group.summary.q3)} ${unit}`],
          ['Lower whisker', `${number(group.summary.low)} ${unit}`], ['Upper whisker', `${number(group.summary.high)} ${unit}`],
          ['Minimum', `${number(group.summary.min)} ${unit}`], ['Maximum', `${number(group.summary.max)} ${unit}`],
          ['Outlier points', group.summary.outliers.toLocaleString()],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>)}</div> : <div className="ca-table-scroll">
        <table className="ca-table">
          <caption className="sr-only">Full-sample GBM thickness distribution statistics in {unit}</caption>
          <thead><tr><th>Comparison group</th><th>Points</th><th>Q1 ({unit})</th><th>Median ({unit})</th><th>Q3 ({unit})</th><th>Outliers</th></tr></thead>
          <tbody>{groups.map(group => <tr key={group.key}>
            <th scope="row">{group.label}</th>
            <td>{group.summary.count.toLocaleString()}</td>
            <td>{number(group.summary.q1)}</td><td>{number(group.summary.median)}</td><td>{number(group.summary.q3)}</td>
            <td>{group.summary.outliers.toLocaleString()}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>
  )
}
