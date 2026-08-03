'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, FileText, FlaskConical, Network, Paperclip, Sparkles, X, Zap } from 'lucide-react'
import type { ChatAttachment, ChatContent, ChatMessage, ChatToolResult } from '../types'
import { STRENGTH, loadPreferredModel, savePreferredModel } from '../../lib/engine'
import { reactFromImage, streamChat } from '../api'
import StructureView from '../components/StructureView'
import ReactionBanner from '../components/ReactionBanner'
import { useToast } from './Toast'

const MAX_TEXT_FILE_CHARS = 8_000        // per attached text file, keeps the
                                         // request under the backend's 24k cap
const MAX_IMAGE_DIMENSION = 1200         // downscale bound before base64 encoding
const MAX_IMAGES_PER_REQUEST = 4         // newest images win when replaying history

const TEXT_FILE_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.smi', '.smiles',
  '.mol', '.sdf', '.cdxml', '.json', '.xml', '.log', '.dat', '.pdb',
]

async function readTextAttachment(file: File): Promise<ChatAttachment> {
  const raw = await file.text()
  if (raw.includes('\u0000')) throw new Error(`${file.name} looks like a binary file.`)
  const text = raw.length > MAX_TEXT_FILE_CHARS
    ? raw.slice(0, MAX_TEXT_FILE_CHARS) + '\n…[truncated]'
    : raw
  return { kind: 'text', name: file.name, text }
}

// Downscale to MAX_IMAGE_DIMENSION and keep whichever of PNG/JPEG is smaller —
// structure drawings compress far better as PNG, photos as JPEG. The result is
// stored in browser localStorage, so size matters.
async function readImageAttachment(file: File): Promise<ChatAttachment> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`Could not read ${file.name} as an image.`))
      el.src = url
    })
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = canvas.toDataURL('image/png')
    const jpeg = canvas.toDataURL('image/jpeg', 0.85)
    const dataUrl = png.length <= jpeg.length ? png : jpeg
    const [prefix, data] = dataUrl.split(',', 2)
    const mediaType = prefix.slice('data:'.length).split(';')[0]
    return { kind: 'image', name: file.name, mediaType, data }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function fileToAttachment(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith('image/')) return readImageAttachment(file)
  const name = file.name.toLowerCase()
  const looksText = file.type.startsWith('text/') || file.type === 'application/json'
    || TEXT_FILE_EXTENSIONS.some(ext => name.endsWith(ext))
  if (!looksText) throw new Error(`${file.name}: unsupported file type. Attach images or text files.`)
  if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} is too large (2 MB max for text files).`)
  return readTextAttachment(file)
}

// Flatten a message for the /chat API: attached text files are inlined into
// the content; images ride along as structured attachments (the backend
// forwards them to the model's vision input).
function toApiMessage(message: ChatMessage, imageBudget: { left: number }) {
  const attachments = message.attachments ?? []
  const parts = [message.content]
  for (const att of attachments) {
    if (att.kind === 'text') parts.push(`\n\n[Attached file: ${att.name}]\n\`\`\`\n${att.text}\n\`\`\``)
  }
  const images = attachments.filter(att => att.kind === 'image').slice(-imageBudget.left)
  imageBudget.left -= images.length
  return {
    role: message.role,
    content: parts.join(''),
    ...(images.length
      ? { attachments: images.map(att => att.kind === 'image'
          ? { kind: 'image', media_type: att.mediaType, data: att.data, name: att.name }
          : null).filter(Boolean) }
      : {}),
  }
}

function toApiMessages(history: ChatMessage[]) {
  const live = history.filter(
    // Failed-request bubbles are UI state, not conversation — don't replay
    // them to the model as if it had said "Error: ..." itself. A deferred
    // reaction bubble carries only its engine card, and an assistant message
    // with empty content is rejected outright by the API.
    message => !(message.role === 'assistant'
      && (message.content.startsWith('Error:') || !message.content.trim())),
  )
  // Newest images win the budget: walk backwards, then restore order.
  const budget = { left: MAX_IMAGES_PER_REQUEST }
  return live.slice().reverse().map(message => toApiMessage(message, budget)).reverse()
}

// Newest engine reaction across the thread's tool results (for the banner's
// initial state when a saved reaction session is reopened).
function findLatestReaction(history: ChatMessage[]): Record<string, unknown> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const hit = history[i].toolResults?.slice().reverse().find(t => t.type === 'reaction_result')
    if (hit) return hit.data
  }
  return null
}

// Cards for tools the assistant ran mid-reply: engine reaction results,
// stockroom updates, pathway analyses.
function ToolResultCards({ results }: { results: ChatToolResult[] }) {
  return (
    <>
      {results.map((result, index) => {
        if (result.type === 'reaction_result') {
          const data = result.data as {
            substrate_smiles?: string; reagent_smiles?: string; environment?: string
            products?: Array<{ smiles: string; reaction_name: string; steps_taken?: number }>
          }
          const products = data.products ?? []
          return (
            <div key={index} className="chat-tool-card">
              <div className="chat-tool-card-head">
                <FlaskConical size={13} />
                Engine reaction: <code>{data.substrate_smiles}</code> + <code>{data.reagent_smiles}</code>
                {data.environment && <span className="chat-tool-tag">{data.environment}</span>}
              </div>
              {products.length ? (
                <div className="chat-tool-products">
                  {products.slice(0, 3).map((product, i) => (
                    <div key={i} className="chat-tool-product">
                      <StructureView smiles={product.smiles} width={170} height={104} />
                      <div className="chat-tool-product-name">{product.reaction_name}</div>
                      <code className="chat-tool-product-smiles">{product.smiles}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="chat-tool-miss">
                  No verified template matched this pair — any product below is an unverified AI guess.
                </div>
              )}
            </div>
          )
        }
        if (result.type === 'set_stockroom') {
          const data = result.data as { smiles?: string[]; mode?: string }
          return (
            <div key={index} className="chat-tool-card">
              <div className="chat-tool-card-head">
                <Network size={13} />
                Stockroom {data.mode === 'add' ? 'extended' : 'updated'}
              </div>
              <div className="chat-tool-products">
                {(data.smiles ?? []).map((smi, i) => (
                  <div key={i} className="chat-tool-product">
                    <StructureView smiles={smi} width={130} height={84} />
                    <code className="chat-tool-product-smiles">{smi}</code>
                  </div>
                ))}
              </div>
            </div>
          )
        }
        if (result.type === 'pathways_result') {
          const data = result.data as { pathways?: { branches?: unknown[]; routes?: unknown[] } }
          const branchCount = data.pathways?.branches?.length ?? 0
          const routeCount = data.pathways?.routes?.length ?? 0
          return (
            <div key={index} className="chat-tool-card">
              <div className="chat-tool-card-head">
                <Network size={13} />
                Pathway analysis complete — {routeCount
                  ? `${routeCount} route${routeCount !== 1 ? 's' : ''} to target`
                  : `${branchCount} pathway${branchCount !== 1 ? 's' : ''}`} · shown in the Synthesis panel
              </div>
            </div>
          )
        }
        return null
      })}
    </>
  )
}

// Claude-style chat: a full-height conversation with drag-and-drop / paste /
// picker file attachments, streaming replies from /chat, autosaved by the
// workspace after each exchange. With a `surface`, the assistant can also
// drive the app: run engine reactions, set the stockroom, run pathways —
// results stream back as cards and as onUiEvent callbacks.
export default function ChatPanel({
  content,
  onChange,
  onSave,
  saving,
  context = null,
  surface = null,
  onUiEvent,
  enableReactionPhoto = false,
  placeholder,
  emptyTitle = 'How can I help?',
  emptyBlurb = 'Ask anything about organic chemistry, or drop in an image or file to discuss. Conversations save automatically.',
}: {
  content: ChatContent
  onChange: (content: ChatContent) => void
  onSave: (content?: ChatContent) => Promise<void>
  saving: boolean
  // Engine-computed reaction context (substrate/reagent/product) forwarded to
  // /chat so answers stay grounded in what's on screen.
  context?: Record<string, unknown> | null
  // Where this chat is embedded — unlocks the matching app tools server-side.
  surface?: 'synthesis' | 'reaction' | 'chat' | null
  // Called for tool events that change the app outside the chat
  // (set_stockroom, pathways_result).
  onUiEvent?: (event: ChatToolResult) => void
  // Adds a camera button that OSR-reads a photo of a whole reaction.
  enableReactionPhoto?: boolean
  placeholder?: string
  emptyTitle?: string
  emptyBlurb?: string
}) {
  const data = content
  const messages: ChatMessage[] = Array.isArray(data.messages) ? data.messages : []
  // The full-reaction banner shows wherever the engine can run mid-conversation:
  // the Reaction tab and general Chat (both expose the run_reaction tool).
  const showReactionBanner = surface === 'reaction' || surface === 'chat'
  // Every named surface unlocks app tools server-side, so every named surface
  // has an engine worth bypassing. A surface-less chat already streams straight
  // from the model and needs no toggle.
  const canBypassEngine = Boolean(surface)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<ChatAttachment[]>([])
  const [streaming, setStreaming] = useState(false)
  const [photoReading, setPhotoReading] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [model, setModel] = useState(STRENGTH.anthropic[0].model)
  // Engine on: the backend may run templates/OSR for this turn and the answer is
  // grounded in verified output. Engine off ("Direct"): the question goes
  // straight to the model. Per-turn and never persisted — the deterministic
  // path is the product, so every new conversation starts back on it.
  const [useEngine, setUseEngine] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  // The composer starts one line tall so its text sits on the same line as the
  // buttons beside it, and grows upward from there as you type.
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Most recent engine reaction seen in this conversation (tool call or photo
  // read) — sent as grounding context on follow-up questions.
  const lastReactionRef = useRef<Record<string, unknown> | null>(null)
  // Same reaction, as render state for the Reaction-tab banner. Seeded from
  // history so a reopened session shows its last reaction immediately.
  const [latestReaction, setLatestReaction] = useState<Record<string, unknown> | null>(
    () => (showReactionBanner ? findLatestReaction(messages) : null),
  )
  const { notify } = useToast()

  useEffect(() => {
    setModel(loadPreferredModel())
  }, [])

  function selectModel(next: string) {
    setModel(next)
    savePreferredModel(next)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streaming])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  async function addFiles(files: Iterable<File>) {
    for (const file of files) {
      try {
        const attachment = await fileToAttachment(file)
        setPending(prev => [...prev, attachment])
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Could not attach file.', 'error')
      }
    }
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragDepth(0)
    if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files)
  }

  function handlePaste(event: React.ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  // Grounding context extracted from an engine reaction result.
  function reactionContextFrom(result: Record<string, unknown>): Record<string, unknown> {
    const products = result?.products as Array<Record<string, unknown>> | undefined
    const top = products?.[0]
    return {
      substrate_smiles: result?.substrate_smiles,
      reagent_smiles: result?.reagent_smiles,
      ...(top ? {
        product_smiles: top.smiles,
        reaction_name: top.reaction_name,
        execution_history: top.execution_history,
      } : {}),
    }
  }

  // A deferred reaction: the engine card is already in the bubble but no prose
  // has been generated for it. The same condition hides the button once prose
  // exists, so a reopened session shows what it already paid for and nothing else.
  function canExplain(message: ChatMessage): boolean {
    return message.role === 'assistant'
      && !message.content.trim()
      && Boolean(message.toolResults?.some(result => result.type === 'reaction_result'))
  }

  // Re-run the turn that produced this bubble, this time asking for the prose.
  // The bubble itself is excluded from the replayed history — it is the message
  // being filled in, and an empty assistant message is rejected by the API —
  // while `targetId` keeps everything after it untouched.
  async function explainMessage(message: ChatMessage) {
    if (streaming || saving) return
    const index = messages.findIndex(entry => entry.id === message.id)
    if (index < 0) return
    await streamReply(messages.slice(0, index), message.toolResults ?? [],
                      undefined, true, message.id)
  }

  // Stream one assistant reply for `history`, collecting tool events into the
  // reply's cards and forwarding app-level events (stockroom, pathways) up.
  async function streamReply(
    history: ChatMessage[],
    seedToolResults: ChatToolResult[] = [],
    contextOverride?: Record<string, unknown> | null,
    // The Reaction tab shows the product first: its turns ask the backend to
    // stop after the engine result. Every other surface answers immediately.
    explain: boolean = surface !== 'reaction',
    // When set, the streamed text fills THIS existing message instead of
    // appending a new one — the Explanation button filling in a bubble that
    // already holds its engine card, without disturbing anything after it.
    targetId?: string,
  ) {
    const assistantId = targetId ?? `msg_${Date.now()}_reply`
    const toolResults: ChatToolResult[] = [...seedToolResults]
    const withReply = (replyText: string): ChatContent => (
      targetId
        ? {
            ...data,
            messages: messages.map(message => (
              message.id === targetId ? { ...message, content: replyText } : message
            )),
          }
        : {
            ...data,
            messages: [
              ...history,
              {
                id: assistantId,
                role: 'assistant',
                content: replyText,
                createdAt: new Date().toISOString(),
                ...(toolResults.length ? { toolResults: [...toolResults] } : {}),
              },
            ],
          }
    )

    setStreaming(true)
    let acc = ''
    try {
      await streamChat(
        toApiMessages(history),
        // Direct mode sends no grounding either: the context block is a previous
        // engine result, and when that result came from a bad OSR read it is
        // exactly what the user is trying to get away from.
        useEngine
          ? (contextOverride !== undefined ? contextOverride : (context ?? lastReactionRef.current))
          : null,
        (delta: string) => {
          acc += delta
          onChange(withReply(acc))
        },
        model,
        surface,
        (event: ChatToolResult) => {
          toolResults.push(event)
          if (event.type === 'reaction_result') {
            lastReactionRef.current = reactionContextFrom(event.data)
            setLatestReaction(event.data)
          }
          if (onUiEvent && (event.type === 'set_stockroom' || event.type === 'pathways_result')) {
            onUiEvent(event)
          }
          onChange(withReply(acc))
        },
        useEngine,
        explain,
      )
      if (!acc && !toolResults.length) {
        throw new Error('The AI engine returned no response. Try again in a moment.')
      }
      await onSave(withReply(acc))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat request failed.'
      onChange(withReply(acc ? `${acc}\n\nError: ${message}` : `Error: ${message}`))
    } finally {
      setStreaming(false)
    }
  }

  async function handleSend() {
    const text = input.trim()
    if ((!text && !pending.length) || streaming || saving) return
    setInput('')
    const attachments = pending
    setPending([])

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    }
    const history = [...messages, userMessage]
    onChange({ ...data, messages: history })
    await streamReply(history)
  }

  // Camera flow: OSR-read a photo of a whole reaction, drop the engine result
  // into the thread as a card, then have the assistant explain it.
  async function handleReactionPhoto(file: File | null | undefined) {
    if (!file || streaming || saving) return
    let imageAttachment: ChatAttachment | null = null
    try {
      imageAttachment = await readImageAttachment(file)
    } catch { /* thumbnail is display-only — proceed without it */ }

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: 'What happens in this reaction?',
      createdAt: new Date().toISOString(),
      ...(imageAttachment ? { attachments: [imageAttachment] } : {}),
    }
    const history = [...messages, userMessage]
    onChange({ ...data, messages: history })
    setPhotoReading(true)
    setStreaming(true)
    try {
      const result = await reactFromImage(file)
      if (result.error) throw new Error(result.error)
      const reactionContext = reactionContextFrom(result)
      lastReactionRef.current = reactionContext
      setLatestReaction(result)
      setPhotoReading(false)
      await streamReply(history, [{ type: 'reaction_result', data: result }], reactionContext)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read the reaction image.'
      onChange({
        ...data,
        messages: [...history, {
          id: `msg_${Date.now()}_reply`,
          role: 'assistant',
          content: `Error: ${message}`,
          createdAt: new Date().toISOString(),
        }],
      })
    } finally {
      setPhotoReading(false)
      setStreaming(false)
    }
  }

  return (
    <div
      className={`claude-chat${messages.length ? '' : ' is-empty'}`}
      onDragEnter={event => { event.preventDefault(); setDragDepth(depth => depth + 1) }}
      onDragLeave={event => { event.preventDefault(); setDragDepth(depth => Math.max(0, depth - 1)) }}
      onDragOver={event => event.preventDefault()}
      onDrop={handleDrop}
    >
      {dragDepth > 0 && (
        <div className="chat-drop-overlay">
          <Paperclip size={22} />
          Drop files to attach
        </div>
      )}

      {showReactionBanner && <ReactionBanner reaction={latestReaction} />}

      <div className="chat-messages chat-messages-full">
        {!messages.length && (
          <div className="chat-empty-state">
            <h2>{emptyTitle}</h2>
            <p>{emptyBlurb}</p>
          </div>
        )}
        {messages.map(message => (
          <div key={message.id} className={`chat-bubble ${message.role}`}>
            {(message.attachments ?? []).some(att => att.kind === 'image') && (
              <div className="chat-bubble-images">
                {(message.attachments ?? []).filter(att => att.kind === 'image').map((att, index) => (
                  att.kind === 'image' && (
                    <img
                      key={index}
                      className="chat-bubble-image"
                      src={`data:${att.mediaType};base64,${att.data}`}
                      alt={att.name || 'attached image'}
                    />
                  )
                ))}
              </div>
            )}
            {(message.attachments ?? []).filter(att => att.kind === 'text').map((att, index) => (
              <span key={index} className="chat-file-chip in-bubble">
                <FileText size={12} /> {att.name}
              </span>
            ))}
            {message.toolResults?.length ? <ToolResultCards results={message.toolResults} /> : null}
            {message.content}
            {canExplain(message) && (
              <button
                type="button"
                className="chat-explain-btn"
                onClick={() => void explainMessage(message)}
                disabled={streaming || saving}
              >
                <Sparkles size={13} />
                Explanation
              </button>
            )}
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role === 'user' && (
          <div className="chat-bubble assistant">
            <div className="loading-row" style={{ margin: 0 }}>
              <div className="spinner" /> {photoReading ? 'Reading the reaction… this can take ~30 seconds' : 'Thinking…'}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-composer">
        {canBypassEngine && !useEngine && (
          <div className="chat-direct-notice">
            Direct — answering from the model alone. No structure recognition, no
            verified product.
          </div>
        )}
        {pending.length > 0 && (
          <div className="chat-attach-row">
            {pending.map((att, index) => (
              <span key={index} className="chat-file-chip">
                {att.kind === 'image' ? (
                  <img className="chat-chip-thumb" src={`data:${att.mediaType};base64,${att.data}`} alt="" />
                ) : (
                  <FileText size={12} />
                )}
                {att.name}
                <button
                  type="button"
                  className="chat-chip-remove"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => setPending(prev => prev.filter((_, i) => i !== index))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <button
            type="button"
            className="chat-attach-button"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={16} />
          </button>
          {enableReactionPhoto && (
            <button
              type="button"
              className="chat-attach-button"
              title={useEngine
                ? 'Photograph a reaction — structures are recognized and run through the engine'
                : 'Photo reading needs the engine — switch off Direct to use it'}
              aria-label="Upload reaction photo"
              disabled={!useEngine}
              onClick={() => photoInputRef.current?.click()}
            >
              <Camera size={16} />
            </button>
          )}
          {canBypassEngine && (
            <button
              type="button"
              className={`chat-attach-button chat-direct-toggle${useEngine ? '' : ' is-active'}`}
              title={useEngine
                ? 'Engine on — verified templates run first, answers stay grounded in them. Click to ask the model directly instead.'
                : 'Direct — this question goes straight to the model: no structure recognition, no templates, no verified product. Click to turn the engine back on.'}
              aria-label="Ask the model directly, bypassing the engine"
              aria-pressed={!useEngine}
              onClick={() => setUseEngine(prev => !prev)}
            >
              <Zap size={16} />
            </button>
          )}
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            value={input}
            placeholder={placeholder ?? 'Ask a question, or attach an image or file…'}
            onChange={event => setInput(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSend()
              }
            }}
          />
          <select
            className="chat-model-select"
            aria-label="AI model"
            value={model}
            onChange={event => selectModel(event.target.value)}
            title={STRENGTH.anthropic.find(s => s.model === model)?.cost}
          >
            {STRENGTH.anthropic.map(stop => (
              <option key={stop.model} value={stop.model}>{stop.label}</option>
            ))}
          </select>
          <button
            className="btn-primary"
            style={{ alignSelf: 'flex-end', padding: '8px 14px' }}
            onClick={handleSend}
            disabled={streaming || saving || (!input.trim() && !pending.length)}
          >
            Send
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={`image/*,${TEXT_FILE_EXTENSIONS.join(',')}`}
          onChange={event => {
            if (event.target.files?.length) void addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        {enableReactionPhoto && (
          <input
            ref={photoInputRef}
            type="file"
            hidden
            accept="image/*"
            capture="environment"
            onChange={event => {
              void handleReactionPhoto(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        )}
      </div>
    </div>
  )
}
