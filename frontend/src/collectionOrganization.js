const ALPHANUMERIC_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export const IMAGE_FILENAME_GROUPS = [
  { id: 'post', label: 'Post', marker: '_post_' },
  { id: 'pre', label: 'Pre', marker: '_pre_' },
  { id: 'other', label: 'Other', marker: null },
]

export const IMAGE_MAGNIFICATION_GROUPS = [
  { id: '10x', label: '10X' },
  { id: '60x', label: '60X' },
  { id: 'other', label: 'Other magnifications' },
]

export function compareAlphanumeric(left, right) {
  const primary = ALPHANUMERIC_COLLATOR.compare(String(left), String(right))
  if (primary !== 0) return primary
  return String(left).localeCompare(String(right))
}

export function sortAlphanumeric(values = []) {
  return [...values].sort(compareAlphanumeric)
}

export function getImageMagnificationGroup(filename) {
  const normalized = String(filename).toLowerCase()
  return IMAGE_MAGNIFICATION_GROUPS.find(
    group => group.id !== 'other' && normalized.includes(group.id),
  )?.id ?? 'other'
}

export function organizeImageFilenamesByMagnification(filenames = []) {
  const grouped = new Map(IMAGE_MAGNIFICATION_GROUPS.map(group => [group.id, []]))

  for (const filename of filenames) {
    grouped.get(getImageMagnificationGroup(filename)).push(filename)
  }

  return IMAGE_MAGNIFICATION_GROUPS.map(group => ({
    ...group,
    files: grouped.get(group.id),
  }))
}

export function organizeImageFilenames(filenames = []) {
  const grouped = new Map(IMAGE_FILENAME_GROUPS.map(group => [group.id, []]))

  for (const filename of filenames) {
    const normalized = String(filename).toLowerCase()
    const groupId = normalized.includes('_pre_')
      ? 'pre'
      : normalized.includes('_post_')
        ? 'post'
        : 'other'
    grouped.get(groupId).push(filename)
  }

  return IMAGE_FILENAME_GROUPS.map(group => ({
    ...group,
    files: grouped.get(group.id),
  }))
}
