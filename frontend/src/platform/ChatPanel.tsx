'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import type { ChatAttachment, ChatContent, ChatMessage } from '../types'
import { STRENGTH } from '../../lib/engine'
import { streamChat } from '../api'
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
    // them to the model as if it had said "Error: ..." itself.
    message => !(message.role === 'assistant' && message.content.startsWith('Error:')),
  )
  // Newest images win the budget: walk backwards, then restore order.
  const budget = { left: MAX_IMAGES_PER_REQUEST }
  return live.slice().reverse().map(message => toApiMessage(message, budget)).reverse()
}

// Claude-style chat: a full-height conversation with drag-and-drop / paste /
// picker file attachments, streaming replies from /chat, autosaved by the
// workspace after each exchange.
export default function ChatPanel({
  content,
  onChange,
  onSave,
  saving,
}: {
  content: ChatContent
  onChange: (content: ChatContent) => void
  onSave: (content?: ChatContent) => Promise<void>
  saving: boolean
}) {
  const data = content
  const messages: ChatMessage[] = Array.isArray(data.messages) ? data.messages : []
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<ChatAttachment[]>([])
  const [streaming, setStreaming] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [model, setModel] = useState(STRENGTH.anthropic[0].model)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { notify } = useToast()

  useEffect(() => {
    const saved = window.localStorage.getItem('orgo.chat.model')
    if (saved && STRENGTH.anthropic.some(s => s.model === saved)) setModel(saved)
  }, [])

  function selectModel(next: string) {
    setModel(next)
    try { window.localStorage.setItem('orgo.chat.model', next) } catch { /* ignore */ }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streaming])

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
    const assistantId = `msg_${Date.now()}_reply`
    const withReply = (replyText: string): ChatContent => ({
      ...data,
      messages: [
        ...history,
        { id: assistantId, role: 'assistant', content: replyText, createdAt: new Date().toISOString() },
      ],
    })

    onChange({ ...data, messages: history })
    setStreaming(true)
    let acc = ''
    try {
      await streamChat(
        toApiMessages(history),
        null,
        (delta: string) => {
          acc += delta
          onChange(withReply(acc))
        },
        model,
      )
      if (!acc) throw new Error('The AI engine returned no response. Try again in a moment.')
      await onSave(withReply(acc))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chat request failed.'
      onChange(withReply(`Error: ${message}`))
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div
      className="claude-chat"
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

      <div className="chat-messages chat-messages-full">
        {!messages.length && (
          <div className="chat-empty-state">
            <h2>How can I help?</h2>
            <p>Ask anything about organic chemistry, or drop in an image or file to discuss. Conversations save automatically.</p>
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
            {message.content}
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role === 'user' && (
          <div className="chat-bubble assistant">
            <div className="loading-row" style={{ margin: 0 }}>
              <div className="spinner" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-composer">
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
          <textarea
            className="chat-input"
            rows={2}
            value={input}
            placeholder="Ask a question, or attach an image or file…"
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
      </div>
    </div>
  )
}
