// What Case analysis already loaded in this browser tab. Leaving the page and
// coming back shows these immediately and refreshes them quietly, instead of
// reading every case, image and measurement again.
export const caseAnalysisSession = {
  caseFiles: new Map(), // caseId -> { files } | { error }
  details: new Map(), // imageKey -> { meta, settings, channelIndex, gap, ... }
  coverage: new Map(), // coverageKey -> { entry, loadedAt }
  analyses: null, // saved analysis summaries
  analysisState: new Map(), // analysisId -> { analysis, distributions }
  views: new Map(), // analysisId -> comparison options, folded cases, scroll position
  draft: null, // the unfinished New analysis selection
  legacyMigrated: new Set(),
}

export function resetCaseAnalysisSession() {
  caseAnalysisSession.caseFiles.clear()
  caseAnalysisSession.details.clear()
  caseAnalysisSession.coverage.clear()
  caseAnalysisSession.analyses = null
  caseAnalysisSession.analysisState.clear()
  caseAnalysisSession.views.clear()
  caseAnalysisSession.draft = null
}
