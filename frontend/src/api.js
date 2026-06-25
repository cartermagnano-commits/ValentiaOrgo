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

export async function fetchExplanation(branch, substrateSMILES) {
  const cls = branch.reaction_classification
  return post('/explain', {
    substrate_smiles: substrateSMILES,
    product_smiles: branch.product_smiles,
    reagent_name: branch.reagent.name,
    reagent_smiles: branch.reagent.smiles,
    reaction_name: cls?.name ?? 'Unknown',
    execution_history: branch.execution_history,
    environment_used: branch.environment,
  })
}

export async function fetchNodeExplanation(nodeData, branch, substrateSMILES) {
  const cls = branch.reaction_classification
  return post('/explain', {
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
  })
}

export async function sendChat(messages, context) {
  return post('/chat', { messages, context })
}
