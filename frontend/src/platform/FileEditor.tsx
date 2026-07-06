'use client'

import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Save } from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import DirectReact from '../components/DirectReact'
import ReactPredict from '../components/ReactPredict'
import type { ChemistryFile, ChemistryFileContent } from '../types'
import { makeInitialContent } from '../../lib/content'
import { streamAssist } from '../api'
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

  useEffect(() => {
    setDraft(file.content || makeInitialContent(file.type))
    setError('')
  }, [file.id, file.content, file.type])

  const related = useMemo(
    () => files.filter(other => other.type === file.type && other.id !== file.id),
    [file.id, file.type, files],
  )

  async function saveContent(nextContent: ChemistryFileContent = draft) {
    setSaving(true)
    setError('')
    try {
      const saved = await updateChemistryFileContent(file.id, file.project_id, userId, nextContent)
      setDraft(saved.content || makeInitialContent(saved.type))
      onSaved(saved)
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
    const fields = { ...(draft as Record<string, unknown>) }
    setDraft({ ...fields, aiResponse: '' } as ChemistryFileContent)
    try {
      await streamAssist(file.type, draft, (delta: string) => {
        acc += delta
        setDraft(prev => ({ ...(prev as Record<string, unknown>), aiResponse: acc }) as ChemistryFileContent)
      })
      await saveContent({ ...fields, aiResponse: acc } as ChemistryFileContent)
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
              <span className="status-pill saved">Saved</span>
              <span className="status-pill muted">{saving ? 'Saving...' : 'AI not run yet'}</span>
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
            initialSubstrate={(draft as any).startingMaterials?.filter(Boolean) ?? []}
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
          <StructuredEditor
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            onPlaceholder={runAssist}
            saving={saving || aiRunning}
            actionLabel="Generate Reply"
            fields={[
              ['notes', 'Chat notes', 'Use this file as a project-scoped chat scratchpad for now.'],
            ]}
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

function SavedContextPanel({
  content,
  onChange,
  onSave,
  onPlaceholder,
  actionLabel,
  saving,
}: {
  content: ChemistryFileContent
  onChange: (content: ChemistryFileContent) => void
  onSave: (content?: ChemistryFileContent) => Promise<void>
  onPlaceholder: () => Promise<void>
  actionLabel: string
  saving: boolean
}) {
  const data = content as Record<string, unknown>

  return (
    <div className="saved-context-panel">
      <label>
        <span>Saved notes</span>
        <textarea
          rows={3}
          value={String(data.notes ?? '')}
          onChange={event => onChange({ ...data, notes: event.target.value } as ChemistryFileContent)}
          onBlur={() => onSave()}
          placeholder="Project-specific context, constraints, observations, or follow-up ideas."
        />
      </label>
      <div className="ai-response-box">
        <Bot size={16} />
        <span>{String(data.aiResponse || 'AI response has not been generated yet.')}</span>
      </div>
      <div className="editor-actions">
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
