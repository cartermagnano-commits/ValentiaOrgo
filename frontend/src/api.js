import { getEnginePayload, loadApiKey } from '../lib/engine'

const BASE = ''  // same-origin; Next.js rewrites (next.config.mjs) proxy to the FastAPI backend

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
  const apiKey = loadApiKey()
  if (apiKey) form.append('api_key', apiKey)
  const res = await fetch(BASE + '/analyze', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Analyze failed')
  }
  return res.json()
}

// Collect the deferred vision verification for an /analyze response that
// returned confidence "verifying". Blocks server-side until the vision read
// finishes; the token is single-use.
export async function verifyAnalysis(token) {
  const res = await fetch(`${BASE}/analyze/verify/${encodeURIComponent(token)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Verification failed')
  }
  return res.json()
}

export async function reactDirect(substrateSMILES, reagentSMILES) {
  return post('/react', {
    substrate_smiles: substrateSMILES,
    reagent_smiles: reagentSMILES,
    engine: getEnginePayload(),
  })
}

export async function reactFromImage(file) {
  const form = new FormData()
  form.append('file', file)
  const apiKey = loadApiKey()
  if (apiKey) form.append('api_key', apiKey)
  const res = await fetch(BASE + '/react-from-image', {
    method: 'POST',
    body: form,
  })
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

async function streamSSE(path, body, onDelta, onToolEvent = null) {
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
  const handleLine = (line) => {
    if (!line.startsWith('data: ')) return false
    const data = line.slice(6).trim()
    if (data === '[DONE]') return true
    let p = null
    try { p = JSON.parse(data) } catch { return false }
    if (p?.error) throw new Error(p.error)
    if (p?.delta) onDelta(p.delta)
    if (p?.tool_event && onToolEvent) onToolEvent(p.tool_event)
    return false
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (handleLine(line)) return
    }
  }
  // A stream that ends without a trailing newline (mid-stream failure,
  // proxy truncation) leaves its last event — often the error frame — in
  // the buffer; deliver it instead of dropping it.
  buffer += decoder.decode()
  if (buffer) handleLine(buffer)
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
    engine: getEnginePayload(),
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
    engine: getEnginePayload(),
  }, onDelta)
}

export async function streamStereo(branch, substrateSMILES, onDelta) {
  const cls = branch.reaction_classification
  return streamSSE('/stereo', {
    substrate_smiles: substrateSMILES,
    product_smiles: branch.product_smiles,
    reagent_name: branch.reagent.name,
    reagent_smiles: branch.reagent.smiles,
    reaction_name: cls?.name ?? 'Unknown',
    execution_history: branch.execution_history,
    environment_used: branch.environment,
    engine: getEnginePayload(),
  }, onDelta)
}

// useEngine=false asks the backend to skip the deterministic engine for this
// turn: no app tools, and no OSR/template run on an attached image.
// explain=false asks it to stop after the engine result — the Reaction tab
// shows the product first and generates prose only when asked.
export async function streamChat(messages, context, onDelta, model = null,
                                 surface = null, onToolEvent = null,
                                 useEngine = true, explain = true) {
  return streamSSE(
    '/chat',
    { messages, context, engine: getEnginePayload(model), surface,
      use_engine: useEngine, explain },
    onDelta,
    onToolEvent,
  )
}
