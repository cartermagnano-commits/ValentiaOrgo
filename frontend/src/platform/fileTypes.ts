import {
  Beaker,
  FlaskConical,
  GitBranch,
  MessageSquare,
  Microscope,
  Network,
  Search,
  Sparkles,
} from 'lucide-react'
import type { ChemistryFileType } from '../types'

export const FILE_TYPES = [
  { type: 'synthesis', code: 'SYN', label: 'Synthesis', icon: Network, defaultTitle: 'Synthesis Pathway', description: 'Pathway exploration and saved synthesis routes' },
  { type: 'direct_reaction', code: 'RXN', label: 'Direct reaction', icon: FlaskConical, defaultTitle: 'Direct Reaction', description: 'Reactants, reagents, conditions, predicted products' },
  { type: 'predict_reaction', code: 'PRED', label: 'Predict reaction', icon: Sparkles, defaultTitle: 'Reaction Prediction', description: 'Photo or structured reaction prediction' },
  { type: 'mechanism', code: 'MECH', label: 'Mechanism', icon: GitBranch, defaultTitle: 'Mechanism', description: 'Mechanism steps and electron-pushing notes' },
  { type: 'retrosynthesis', code: 'RETRO', label: 'Retrosynthesis', icon: Search, defaultTitle: 'Retrosynthesis', description: 'Target disconnections and precursor planning' },
  { type: 'molecule_note', code: 'MOL', label: 'Molecule note', icon: Microscope, defaultTitle: 'Molecule Note', description: 'SMILES, functional groups, observations' },
  { type: 'chat', code: 'NOTE', label: 'General chat', icon: MessageSquare, defaultTitle: 'Project Notes', description: 'Project-scoped chemistry notes and assistant chat' },
] as const

export function fileTypeMeta(type: ChemistryFileType) {
  return FILE_TYPES.find(item => item.type === type) ?? FILE_TYPES[0]
}

export { Beaker }
