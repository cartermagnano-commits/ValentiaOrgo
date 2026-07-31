'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, FileText, Paperclip, Save, X } from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import DirectReact from '../components/DirectReact'
import ReactPredict from '../components/ReactPredict'
import MolDrawer from '../components/MolDrawer'
import StructureView from '../components/StructureView'
import type { ChatAttachment, ChatContent, ChemistryFile, ChemistryFileContent } from '../types'
import { makeInitialContent } from '../../lib/content'
import { STRENGTH } from '../../lib/engine'
import { streamAssist, streamChat } from '../api'
import { updateChemistryFileContent } from '../../lib/database'
import { useToast } from './Toast'
import { fileTypeMeta } from './fileTypes'
import { formatDate, statusText } from './format'

export default function FileEditor({
  file,
  files,
  userId,
  onSaved,
}: {
  file: ChemistryFile
  files: ChemistryFile[]
  userId: string
  onSaved: (file: ChemistryFile) => void
}) {
  const [draft, setDraft] = useState<ChemistryFileContent>(file.content || makeInitialContent(file.type))
  const [saving, setSaving] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [error, setError] = useState('')
  const meta = fileTypeMeta(file.type)
  const Icon = meta.icon
  const { notify } = useToast()
  const hasAiRun = Boolean(
    (draft as any).aiResponse || (draft as any).pathwaysData || (draft as any).result
  )

  // Reset the working draft only when switching to a DIFFERENT file. Depending
  // on file.content here would re-apply the just-saved server copy after every
  // save, reverting anything typed while the save round-trip was in flight.
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    setDraft(file.content || makeInitialContent(file.type))
    setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id])

  const related = useMemo(
    () => files.filter(other => other.type === file.type && other.id !== file.id),
    [file.id, file.type, files],
  )

  // Optimistic-concurrency bookkeeping. lastSavedAtRef tracks the freshest
  // updated_at we know about (updated the moment a save resolves, without
  // waiting for the parent re-render), and saveChainRef serializes saves so a
  // textarea onBlur save and a Save-button save firing back-to-back can't race
  // each other into a false "modified elsewhere" conflict.
  const lastSavedAtRef = useRef<string | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  async function saveContent(nextContent: ChemistryFileContent = draft) {
    setSaving(true)
    setError('')
    const run = async () => {
      const expected = lastSavedAtRef.current ?? file.updated_at
      const saved = await updateChemistryFileContent(file.id, file.project_id, userId, nextContent, expected)
      lastSavedAtRef.current = saved.updated_at
      // Deliberately do NOT reset the draft from the server response — the
      // user may have kept typing during the round-trip; local state wins.
      onSaved(saved)
    }
    const attempt = saveChainRef.current.then(run, run)
    saveChainRef.current = attempt.catch(() => {})
    try {
      await attempt
      notify('Saved', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save file.'
      setError(msg)
      notify(msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function runAssist() {
    setError('')
    setAiRunning(true)
    let acc = ''
    const request = { ...(draft as Record<string, unknown>) }
    setDraft(prev => ({ ...(prev as Record<string, unknown>), aiResponse: '' }) as ChemistryFileContent)
    try {
      await streamAssist(file.type, request, (delta: string) => {
        acc += delta
        setDraft(prev => ({ ...(prev as Record<string, unknown>), aiResponse: acc }) as ChemistryFileContent)
      })
      if (!acc) throw new Error('The AI engine returned no response. Check Settings → Engine.')
      // Save from the LATEST draft (via ref), not the pre-stream snapshot —
      // fields the user edited while the AI streamed must survive the save.
      await saveContent({ ...(draftRef.current as Record<string, unknown>), aiResponse: acc } as ChemistryFileContent)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed.')
    } finally {
      setAiRunning(false)
    }
  }

  const isChat = file.type === 'chat'

  return (
    <section className={`file-editor-shell${isChat ? ' chat-shell' : ''}`}>
      {isChat ? (
        // A chatbot surface, not a chemistry file: title only, no engine or
        // save-status pills competing with the conversation.
        <div className="file-editor-header chat-header">
          <div className="file-title-row">
            <span className="file-type-icon"><Icon size={17} /></span>
            <h3>{file.title}</h3>
          </div>
          <div className="file-dates">{saving ? 'Saving…' : statusText(file.updated_at)}</div>
        </div>
      ) : (
        <div className="file-editor-header">
          <div className="file-title-row">
            <span className="file-type-icon"><Icon size={17} /></span>
            <div>
              <div className="file-heading-meta">
                <span className="file-type-badge strong">{meta.code}</span>
                <span className="status-pill saved">{saving ? 'Saving…' : 'Saved'}</span>
                <span className="status-pill muted">
                  {aiRunning ? 'AI running…' : hasAiRun ? 'AI response saved' : 'AI not run yet'}
                </span>
              </div>
              <h3>{file.title}</h3>
            </div>
          </div>
          <div className="file-dates">
            {statusText(file.updated_at)} · Created {formatDate(file.created_at)}
          </div>
        </div>
      )}

      {(file.type === 'synthesis' || file.type === 'direct_reaction' || file.type === 'predict_reaction') && (
        <RelatedTabs currentFile={file} related={related} />
      )}

      {error && <div className="error-banner editor-banner">{error}</div>}

      <div className="file-editor-content">
        {file.type !== 'chat' && (
          <MoleculeOfInterestPanel
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
          />
        )}

        {file.type === 'synthesis' && (
          <PathwayExplorer
            key={file.id}
            initialSubstrate={Array.isArray((draft as any).startingMaterials)
              ? (draft as any).startingMaterials.filter(Boolean)
              : []}
            initialTarget={(draft as any).targetMolecule ?? ''}
            initialPathways={(draft as any).pathwaysData ?? null}
            onSave={(data: any) => saveContent({ ...draft, ...data })}
          />
        )}
        {file.type === 'direct_reaction' && (
          <DirectReact
            key={file.id}
            initialSubstrate={(draft as any).reactants?.[0] ?? ''}
            initialReagent={(draft as any).reagents ?? ''}
            initialResult={(draft as any).result ?? null}
            onSave={(data: any) => saveContent({ ...draft, ...data })}
          />
        )}
        {file.type === 'predict_reaction' && (
          <ReactPredict
            key={file.id}
            initialResult={(draft as any).result ?? null}
            onSave={(data: any) => saveContent({ ...draft, ...data })}
          />
        )}
        {file.type === 'mechanism' && (
          <StructuredEditor
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            onPlaceholder={runAssist}
            saving={saving || aiRunning}
            actionLabel="Explain Mechanism"
            fields={[
              ['reactionInput', 'Reaction input', 'Paste reaction SMILES, reagent context, or a plain-language reaction description.'],
              ['mechanismStepsText', 'Mechanism steps', 'Step 1: describe bond formation/breaking. Add more steps as this file evolves.'],
              ['electronPushingNotes', 'Electron-pushing notes', 'Capture curved-arrow logic, nucleophile/electrophile assignments, and charges.'],
              ['notes', 'Notes', 'General study notes and assumptions.'],
            ]}
          />
        )}
        {file.type === 'retrosynthesis' && (
          <StructuredEditor
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            onPlaceholder={runAssist}
            saving={saving || aiRunning}
            actionLabel="Generate Synthesis"
            fields={[
              ['targetMolecule', 'Target molecule', 'Target SMILES or molecule name.'],
              ['disconnectionsText', 'Disconnections', 'Key bonds to disconnect and rationale.'],
              ['proposedPrecursorsText', 'Proposed precursors', 'Candidate starting materials and synthetic equivalents.'],
              ['notes', 'Notes', 'Constraints, protecting-group concerns, and route assumptions.'],
            ]}
          />
        )}
        {file.type === 'molecule_note' && (
          <StructuredEditor
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            onPlaceholder={runAssist}
            saving={saving || aiRunning}
            actionLabel="Save Observation"
            fields={[
              ['moleculeName', 'Molecule name', 'Common name, project code, or IUPAC shorthand.'],
              ['smiles', 'SMILES string', 'Canonical or working SMILES.'],
              ['functionalGroupsText', 'Functional groups', 'Alcohol, ketone, alkyl halide, alkene, etc.'],
              ['notes', 'Notes', 'Reactivity, hazards, synthesis context, or observations.'],
              ['savedObservationsText', 'Saved observations', 'Experimental or study observations attached to this molecule.'],
            ]}
          />
        )}
        {file.type === 'chat' && (
          <PersistedChat
            key={file.id}
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            saving={saving}
          />
        )}
      </div>
    </section>
  )
}

function RelatedTabs({ currentFile, related }: { currentFile: ChemistryFile; related: ChemistryFile[] }) {
  return (
    <div className="related-file-tabs">
      <span className="related-tab active">{currentFile.title}</span>
      {related.map(file => (
        <span key={file.id} className="related-tab">{file.title}</span>
      ))}
      {!related.length && <span className="related-empty">No previous saved files of this type in this project.</span>}
    </div>
  )
}

function MoleculeOfInterestPanel({
  content,
  onChange,
  onSave,
}: {
  content: ChemistryFileContent
  onChange: (content: ChemistryFileContent) => void
  onSave: (content?: ChemistryFileContent) => Promise<void>
}) {
  const data = content as Record<string, unknown>
  const value = String(data.moleculeOfInterest ?? '')

  function updateMolecule(value: string, save = false) {
    const next = { ...data, moleculeOfInterest: value } as ChemistryFileContent
    onChange(next)
    if (save) void onSave(next)
  }

  return (
    <div className="molecule-interest-panel">
      <div className="molecule-interest-copy">
        <span className="smiles-label">Molecule of interest</span>
        <textarea
          className="smiles-input"
          rows={2}
          value={value}
          onChange={event => updateMolecule(event.target.value)}
          onBlur={() => onSave()}
          placeholder="Draw or paste the molecule you want this file to center on."
          spellCheck={false}
        />
      </div>
      <div className="molecule-interest-preview">
        {value ? (
          <StructureView smiles={value} width={180} height={100} className="structure-outline" />
        ) : (
          <span>No molecule selected</span>
        )}
      </div>
      <MolDrawer
        value={value}
        onChange={smiles => updateMolecule(smiles, true)}
        buttonLabel="Draw Molecule"
      />
    </div>
  )
}

function StructuredEditor({
  content,
  onChange,
  onSave,
  onPlaceholder,
  saving,
  actionLabel,
  fields,
}: {
  content: ChemistryFileContent
  onChange: (content: ChemistryFileContent) => void
  onSave: (content?: ChemistryFileContent) => Promise<void>
  onPlaceholder: () => Promise<void>
  saving: boolean
  actionLabel: string
  fields: Array<[string, string, string]>
}) {
  const data = content as Record<string, unknown>

  function valueFor(key: string) {
    if (key === 'mechanismStepsText') return Array.isArray(data.mechanismSteps)
      ? data.mechanismSteps.map((step: any) => step.description || step.label).join('\n')
      : ''
    if (key === 'disconnectionsText') return Array.isArray(data.disconnections) ? data.disconnections.join('\n') : ''
    if (key === 'proposedPrecursorsText') return Array.isArray(data.proposedPrecursors) ? data.proposedPrecursors.join('\n') : ''
    if (key === 'functionalGroupsText') return Array.isArray(data.functionalGroups) ? data.functionalGroups.join(', ') : ''
    if (key === 'savedObservationsText') return Array.isArray(data.savedObservations) ? data.savedObservations.join('\n') : ''
    return String(data[key] ?? '')
  }

  function updateField(key: string, value: string) {
    let next: Record<string, unknown> = { ...data, [key]: value }
    if (key === 'mechanismStepsText') {
      next = {
        ...data,
        mechanismSteps: value.split('\n').filter(Boolean).map((description, index) => ({
          id: `step_${index + 1}`,
          label: `Step ${index + 1}`,
          description,
        })),
      }
    }
    if (key === 'disconnectionsText') next = { ...data, disconnections: splitLines(value) }
    if (key === 'proposedPrecursorsText') next = { ...data, proposedPrecursors: splitLines(value) }
    if (key === 'functionalGroupsText') next = { ...data, functionalGroups: value.split(',').map(item => item.trim()).filter(Boolean) }
    if (key === 'savedObservationsText') next = { ...data, savedObservations: splitLines(value) }
    onChange(next as ChemistryFileContent)
  }

  function applyDrawnMolecule(key: string, smiles: string) {
    const current = valueFor(key).trim()
    const shouldAppend = key.endsWith('Text') || key === 'reactionInput'
    const nextValue = shouldAppend && current ? `${current}\n${smiles}` : smiles
    updateField(key, nextValue)
  }

  return (
    <div className="generic-editor">
      {fields.map(([key, label, placeholder]) => (
        <label key={key} className={key === 'notes' || key.endsWith('Text') ? 'wide-field' : ''}>
          <div className="structured-field-header">
            <span>{label}</span>
            {isMoleculeField(key) && (
              <MolDrawer
                value={valueFor(key)}
                onChange={smiles => applyDrawnMolecule(key, smiles)}
              />
            )}
          </div>
          <textarea
            rows={key.endsWith('Text') || key === 'notes' ? 5 : 3}
            value={valueFor(key)}
            onChange={event => updateField(key, event.target.value)}
            onBlur={() => onSave()}
            placeholder={placeholder}
          />
        </label>
      ))}
      <div className="ai-placeholder">
        <Bot size={16} />
        {String(data.aiResponse || 'AI response has not been generated yet.')}
      </div>
      <div className="editor-actions wide-field">
        <button className="btn-secondary action-button" onClick={() => onSave()} disabled={saving}>
          <Save size={15} />
          Save
        </button>
        <button className="btn-primary action-button" onClick={onPlaceholder} disabled={saving}>
          <CheckCircle2 size={15} />
          {actionLabel}
        </button>
      </div>
    </div>
  )
}

function splitLines(value: string) {
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}

function isMoleculeField(key: string) {
  return [
    'reactionInput',
    'targetMolecule',
    'smiles',
    'disconnectionsText',
    'proposedPrecursorsText',
  ].includes(key)
}

type ChatMessage = ChatContent['messages'][number]

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
// stored in the file's jsonb content, so size matters.
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

// Claude-style persisted chat for "General chat" files: a full-height
// conversation with drag-and-drop / paste / picker file attachments, streaming
// replies from /chat, saved into the file's jsonb content after each exchange.
function PersistedChat({
  content,
  onChange,
  onSave,
  saving,
}: {
  content: ChemistryFileContent
  onChange: (content: ChemistryFileContent) => void
  onSave: (content?: ChemistryFileContent) => Promise<void>
  saving: boolean
}) {
  const data = content as ChatContent
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
      if (!acc) throw new Error('The AI engine returned no response. Check Settings → Engine.')
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
            <p>Ask anything about organic chemistry, or drop in an image or file to discuss. This conversation is saved with the file.</p>
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
