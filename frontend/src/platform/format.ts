export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

export function statusText(value: string) {
  const diffMs = Date.now() - new Date(value).getTime()
  const days = Math.max(0, Math.floor(diffMs / 86400000))
  if (days === 0) return 'Edited recently'
  if (days === 1) return 'Edited yesterday'
  return `Edited ${days} days ago`
}
