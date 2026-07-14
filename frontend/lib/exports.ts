// Client-side export/copy helpers for molecules and reactions.

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// The backend /molfile endpoint sets Content-Disposition, so navigating downloads it.
export function downloadMolfile(smiles: string, name = 'molecule') {
  triggerDownload(`/molfile?smiles=${encodeURIComponent(smiles)}&name=${encodeURIComponent(name)}`)
}

export async function downloadSvg(smiles: string, name = 'structure') {
  const res = await fetch(`/structure?smiles=${encodeURIComponent(smiles)}&width=400&height=300`)
  if (!res.ok) throw new Error('Could not render structure')
  const svg = await res.text()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  triggerDownload(url, `${name}.svg`)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

interface ReportProduct { smiles: string; reaction_name?: string; execution_history?: string[] }

export function buildReactionReport(input: {
  substrate?: string
  reagent?: string
  environment?: string
  products: ReportProduct[]
}): string {
  const lines: string[] = ['# Orgo AI — Reaction Report', '']
  if (input.substrate) lines.push(`**Substrate:** \`${input.substrate}\``)
  if (input.reagent) lines.push(`**Reagent:** \`${input.reagent}\``)
  if (input.environment) lines.push(`**Control:** ${input.environment}`)
  lines.push('', `## Predicted products (${input.products.length})`, '')
  input.products.forEach((p, i) => {
    lines.push(`### Product ${i + 1}${p.reaction_name ? ` — ${p.reaction_name}` : ''}`)
    lines.push(`- SMILES: \`${p.smiles}\``)
    if (p.execution_history?.length) {
      lines.push('- Mechanism:')
      p.execution_history.forEach(step => lines.push(`  - ${step}`))
    }
    lines.push('')
  })
  return lines.join('\n')
}
