'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, Save } from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import DirectReact from '../components/DirectReact'
import ReactPredict from '../components/ReactPredict'
import type { ChatContent, ChemistryFile, ChemistryFileContent } from '../types'
import { makeInitialContent } from '../../lib/content'
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

  return (
    <section className="file-editor-shell">
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

      {(file.type === 'synthesis' || file.type === 'direct_reaction' || file.type === 'predict_reaction') && (
        <RelatedTabs currentFile={file} related={related} />
      )}

      {error && <div className="error-banner editor-banner">{error}</div>}

      <div className="file-editor-content">
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

  return (
    <div className="generic-editor">
      {fields.map(([key, label, placeholder]) => (
        <label key={key} className={key === 'notes' || key.endsWith('Text') ? 'wide-field' : ''}>
          <span>{label}</span>
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

type ChatMessage = ChatContent['messages'][number]

// Real persisted chat for "chat" files: streams replies from /chat and saves
// the full transcript into the file's jsonb content after each exchange.
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
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streaming])

  async function handleSend() {
    const text = input.trim()
    if (!text || streaming || saving) return
    setInput('')

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
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
        history
          // Failed-request bubbles are UI state, not conversation — don't
          // replay them to the model as if it had said "Error: ..." itself.
          .filter(message => !(message.role === 'assistant' && message.content.startsWith('Error:')))
          .map(message => ({ role: message.role, content: message.content })),
        null,
        (delta: string) => {
          acc += delta
          onChange(withReply(acc))
        },
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
    <div className="panel-body" style={{ gap: 10, minHeight: 380 }}>
      <div className="chat-messages" style={{ flex: 1 }}>
        {!messages.length && (
          <div className="chat-bubble assistant">
            Hi! Ask me anything about organic chemistry. This conversation is saved with the file.
          </div>
        )}
        {messages.map(message => (
          <div key={message.id} className={`chat-bubble ${message.role}`}>
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

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          value={input}
          placeholder="Ask about mechanisms, reagents, or any orgo concept…"
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSend()
            }
          }}
        />
        <button
          className="btn-primary"
          style={{ alignSelf: 'flex-end', padding: '8px 14px' }}
          onClick={handleSend}
          disabled={streaming || saving || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
