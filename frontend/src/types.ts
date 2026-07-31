export type Tool = 'synthesis' | 'direct_reaction' | 'chat'

export type ChatAttachment =
  | { kind: 'image'; name: string; mediaType: string; data: string }  // raw base64
  | { kind: 'text'; name: string; text: string }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  attachments?: ChatAttachment[]
}

export type ChatContent = {
  messages: ChatMessage[]
}

export type SynthesisContent = {
  targetMolecule?: string
  startingMaterials: string[]
  pathwaysData?: unknown
  assistantMessages?: ChatMessage[]   // the tool's side-drawer chat
}

export type DirectReactionContent = {
  reactants: string[]
  reagents?: string
  result?: unknown
  assistantMessages?: ChatMessage[]   // the tool's side-drawer chat
}

export type SessionContent = SynthesisContent | DirectReactionContent | ChatContent
