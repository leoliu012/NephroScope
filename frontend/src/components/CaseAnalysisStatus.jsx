import { CheckCircle2, CircleAlert, CirclePause, Loader2 } from 'lucide-react'

export function analysisProgress(counts = {}) {
  const total = counts.total || 0
  const done = counts.succeeded || 0
  return { total, done, percent: total ? Math.round(100 * done / total) : 0 }
}

export function analysisStatusText(analysis) {
  const counts = analysis?.counts || {}
  const { total, done } = analysisProgress(counts)
  switch (analysis?.status) {
    case 'complete': return 'Complete'
    case 'running': return `Running · ${done}/${total}`
    case 'interrupted': return counts.running ? `Interrupting · ${counts.running} finishing` : `Interrupted · ${done}/${total}`
    case 'incomplete': return `Incomplete · ${done}/${total}`
    case 'finished-with-issues': return `${counts.failed} failed · ${done}/${total}`
    default: return 'Unknown'
  }
}

export function AnalysisStatusBadge({ analysis }) {
  const status = analysis?.status
  const Icon = status === 'complete' ? CheckCircle2
    : status === 'running' || (status === 'interrupted' && analysis?.counts?.running) ? Loader2
      : status === 'interrupted' ? CirclePause : CircleAlert
  return <span className={`ca-status-badge ca-status-${status || 'unknown'}`}>
    <Icon size={12} className={Icon === Loader2 ? 'animate-spin' : ''} aria-hidden="true" />
    {analysisStatusText(analysis)}
  </span>
}
