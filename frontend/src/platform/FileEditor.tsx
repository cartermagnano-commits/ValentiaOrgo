'use client'

import { useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Save } from 'lucide-react'
import PathwayExplorer from '../components/PathwayExplorer'
import DirectReact from '../components/DirectReact'
import ReactPredict from '../components/ReactPredict'
import MolDrawer from '../components/MolDrawer'
import StructureView from '../components/StructureView'
import type { ChemistryFile, ChemistryFileContent } from '../types'
import { makeInitialContent, withPlaceholderAiResponse } from '../../lib/content'
import { updateChemistryFileContent } from '../../lib/database'
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
  const [error, setError] = useState('')
  const meta = fileTypeMeta(file.type)
  const Icon = meta.icon

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save file.')
    } finally {
      setSaving(false)
    }
  }

  async function runPlaceholderAi() {
    const nextContent = withPlaceholderAiResponse(draft)
    setDraft(nextContent)
    await saveContent(nextContent)
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
        <MoleculeOfInterestPanel
          content={draft}
          onChange={setDraft}
          onSave={saveContent}
        />

        {file.type === 'synthesis' && (
          <>
            <SavedContextPanel
              content={draft}
              onChange={setDraft}
              onSave={saveContent}
              onPlaceholder={runPlaceholderAi}
              actionLabel="Generate Synthesis"
              saving={saving}
            />
            <PathwayExplorer />
          </>
        )}
        {file.type === 'direct_reaction' && (
          <>
            <SavedContextPanel
              content={draft}
              onChange={setDraft}
              onSave={saveContent}
              onPlaceholder={runPlaceholderAi}
              actionLabel="Predict Product"
              saving={saving}
            />
            <DirectReact />
          </>
        )}
        {file.type === 'predict_reaction' && (
          <>
            <SavedContextPanel
              content={draft}
              onChange={setDraft}
              onSave={saveContent}
              onPlaceholder={runPlaceholderAi}
              actionLabel="Predict Product"
              saving={saving}
            />
            <ReactPredict />
          </>
        )}
        {file.type === 'mechanism' && (
          <StructuredEditor
            content={draft}
            onChange={setDraft}
            onSave={saveContent}
            onPlaceholder={runPlaceholderAi}
            saving={saving}
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
            onPlaceholder={runPlaceholderAi}
            saving={saving}
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
            onPlaceholder={runPlaceholderAi}
            saving={saving}
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
            onPlaceholder={runPlaceholderAi}
            saving={saving}
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
