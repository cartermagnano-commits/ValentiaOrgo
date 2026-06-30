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
  { type: 'synthesis', code: 'SYN', label: 'Synthesis', icon: Network, description: 'Pathway exploration and saved synthesis routes' },
  { type: 'direct_reaction', code: 'RXN', label: 'Direct reaction', icon: FlaskConical, description: 'Reactants, reagents, conditions, predicted products' },
  { type: 'predict_reaction', code: 'PRED', label: 'Predict reaction', icon: Sparkles, description: 'Photo or structured reaction prediction' },
  { type: 'mechanism', code: 'MECH', label: 'Mechanism', icon: GitBranch, description: 'Mechanism steps and electron-pushing notes' },
  { type: 'retrosynthesis', code: 'RETRO', label: 'Retrosynthesis', icon: Search, description: 'Target disconnections and precursor planning' },
  { type: 'molecule_note', code: 'MOL', label: 'Molecule note', icon: Microscope, description: 'SMILES, functional groups, observations' },
  { type: 'chat', code: 'NOTE', label: 'General chat', icon: MessageSquare, description: 'Project-scoped chemistry notes and assistant chat' },
] as const

export function fileTypeMeta(type: ChemistryFileType) {
  return FILE_TYPES.find(item => item.type === type) ?? FILE_TYPES[0]
}

export { Beaker }
