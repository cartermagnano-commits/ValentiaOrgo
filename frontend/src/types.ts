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

export type SynthesisContent = {
  targetMolecule?: string
  startingMaterials: string[]
  constraints?: string
  notes?: string
  aiResponse?: string
}

export type DirectReactionContent = {
  reactants: string[]
  reagents?: string
  solventConditions?: string
  predictedProducts: string[]
  notes?: string
  aiResponse?: string
}

export type PredictReactionContent = {
  reactants: string[]
  reagents?: string
  conditions?: string
  predictedMajorProduct?: string
  sideProducts: string[]
  notes?: string
  aiResponse?: string
}

export type MechanismContent = {
  reactionInput?: string
  mechanismSteps: MechanismStep[]
  electronPushingNotes?: string
  notes?: string
  aiResponse?: string
}

export type RetrosynthesisContent = {
  targetMolecule?: string
  disconnections: string[]
  proposedPrecursors: string[]
  notes?: string
  aiResponse?: string
}

export type MoleculeNoteContent = {
  moleculeName?: string
  smiles?: string
  functionalGroups: string[]
  notes?: string
  savedObservations: string[]
}

export type ChatContent = {
  notes?: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
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
