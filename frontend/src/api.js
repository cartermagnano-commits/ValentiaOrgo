const BASE = ''  // same-origin; Vite proxy handles /api calls in dev

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  return res.json()
}

export async function analyzeImage(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(BASE + '/analyze', { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Analyze failed')
  }
  return res.json()
}

export async function reactDirect(substrateSMILES, reagentSMILES) {
  return post('/react', { substrate_smiles: substrateSMILES, reagent_smiles: reagentSMILES })
}

export async function reactFromImage(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(BASE + '/react-from-image', { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Prediction failed')
  }
  return res.json()
}

export function structureUrl(smiles, width = 200, height = 150) {
  return `/structure?smiles=${encodeURIComponent(smiles)}&width=${width}&height=${height}`
}

export async function fetchPathways(startSmilesList, targetSMILES, desiredDepth = 5) {
  return post('/pathways', {
    start_smiles: Array.isArray(startSmilesList) ? startSmilesList : [startSmilesList],
    target_smiles: targetSMILES || null,
    desired_depth: Math.max(1, Math.min(10, Math.round(desiredDepth))),
  })
}

async function streamSSE(path, body, onDelta) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return
      try { const p = JSON.parse(data); if (p.delta) onDelta(p.delta) } catch {}
    }
  }
}

export async function streamExplanation(branch, substrateSMILES, onDelta) {
  const cls = branch.reaction_classification
  return streamSSE('/explain', {
    substrate_smiles: substrateSMILES,
    product_smiles: branch.product_smiles,
    reagent_name: branch.reagent.name,
    reagent_smiles: branch.reagent.smiles,
    reaction_name: cls?.name ?? 'Unknown',
    execution_history: branch.execution_history,
    environment_used: branch.environment,
  }, onDelta)
}

export async function streamNodeExplanation(nodeData, branch, substrateSMILES, onDelta) {
  const cls = branch.reaction_classification
  return streamSSE('/explain', {
    substrate_smiles: substrateSMILES,
    product_smiles: branch.product_smiles,
    reagent_name: branch.reagent.name,
    reagent_smiles: branch.reagent.smiles,
    reaction_name: cls?.name ?? 'Unknown',
    execution_history: branch.execution_history,
    environment_used: branch.environment,
    node_smiles: nodeData.smiles,
    node_role: nodeData.nodeType,
    node_step_text: nodeData.stepText ?? '',
  }, onDelta)
}

export async function streamChat(messages, context, onDelta) {
  return streamSSE('/chat', { messages, context }, onDelta)
}
