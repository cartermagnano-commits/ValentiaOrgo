import type { ChemistryFileContent, ChemistryFileType } from '../src/types'

export function makeInitialContent(type: ChemistryFileType): ChemistryFileContent {
  if (type === 'synthesis') {
    return { moleculeOfInterest: '', targetMolecule: '', startingMaterials: [''], constraints: '', notes: '', aiResponse: '' }
  }
  if (type === 'direct_reaction') {
    return { moleculeOfInterest: '', reactants: [''], reagents: '', solventConditions: '', predictedProducts: [], notes: '', aiResponse: '' }
  }
  if (type === 'predict_reaction') {
    return { moleculeOfInterest: '', reactants: [''], reagents: '', conditions: '', predictedMajorProduct: '', sideProducts: [], notes: '', aiResponse: '' }
  }
  if (type === 'mechanism') {
    return { moleculeOfInterest: '', reactionInput: '', mechanismSteps: [], electronPushingNotes: '', notes: '', aiResponse: '' }
  }
  if (type === 'retrosynthesis') {
    return { moleculeOfInterest: '', targetMolecule: '', disconnections: [], proposedPrecursors: [], notes: '', aiResponse: '' }
  }
  if (type === 'molecule_note') {
    return { moleculeOfInterest: '', moleculeName: '', smiles: '', functionalGroups: [], notes: '', savedObservations: [] }
  }
  return { moleculeOfInterest: '', notes: '', messages: [] }
}

export function withPlaceholderAiResponse(content: ChemistryFileContent): ChemistryFileContent {
  return { ...(content as Record<string, unknown>), aiResponse: 'AI response will appear here.' } as ChemistryFileContent
}
