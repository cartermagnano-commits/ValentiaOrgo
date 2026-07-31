export type ChemistryFileType =
  | 'synthesis'
  | 'direct_reaction'
  | 'predict_reaction'
  | 'mechanism'
  | 'retrosynthesis'
  | 'molecule_note'
  | 'chat'

export type MechanismStep = {
  id: string
  label: string
  description: string
  electronPushingNotes?: string
}

export type MoleculeContext = {
  moleculeOfInterest?: string
}

export type SynthesisContent = MoleculeContext & {
  targetMolecule?: string
  startingMaterials: string[]
  constraints?: string
  notes?: string
  aiResponse?: string
}

export type DirectReactionContent = MoleculeContext & {
  reactants: string[]
  reagents?: string
  solventConditions?: string
  predictedProducts: string[]
  notes?: string
  aiResponse?: string
}

export type PredictReactionContent = MoleculeContext & {
  reactants: string[]
  reagents?: string
  conditions?: string
  predictedMajorProduct?: string
  sideProducts: string[]
  notes?: string
  aiResponse?: string
}

export type MechanismContent = MoleculeContext & {
  reactionInput?: string
  mechanismSteps: MechanismStep[]
  electronPushingNotes?: string
  notes?: string
  aiResponse?: string
}

export type RetrosynthesisContent = MoleculeContext & {
  targetMolecule?: string
  disconnections: string[]
  proposedPrecursors: string[]
  notes?: string
  aiResponse?: string
}

export type MoleculeNoteContent = MoleculeContext & {
  moleculeName?: string
  smiles?: string
  functionalGroups: string[]
  notes?: string
  savedObservations: string[]
}

export type ChatAttachment =
  | { kind: 'image'; name: string; mediaType: string; data: string }  // raw base64
  | { kind: 'text'; name: string; text: string }

export type ChatContent = MoleculeContext & {
  notes?: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
    attachments?: ChatAttachment[]
  }>
}

export type ChemistryFileContent =
  | SynthesisContent
  | DirectReactionContent
  | PredictReactionContent
  | MechanismContent
  | RetrosynthesisContent
  | MoleculeNoteContent
  | ChatContent

export type ChemistryFile = {
  id: string
  project_id: string
  user_id: string
  title: string
  type: ChemistryFileType
  content: ChemistryFileContent
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  user_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  fileCount?: number
}
