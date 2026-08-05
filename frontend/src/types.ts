export type Tool = 'synthesis' | 'direct_reaction' | 'chat'

export type ChatAttachment =
  | { kind: 'image'; name: string; mediaType: string; data: string }  // raw base64
  | { kind: 'text'; name: string; text: string }

// A tool the assistant ran during its reply (engine reaction, stockroom
// update, pathway analysis) — rendered as a card inside the bubble.
export type ChatToolResult = {
  type: 'reaction_result' | 'set_stockroom' | 'pathways_result'
  data: Record<string, unknown>
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  attachments?: ChatAttachment[]
  toolResults?: ChatToolResult[]
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

// Reaction sessions are chat-shaped: molecules arrive typed or photographed
// in the conversation, engine results render as cards in the thread.
export type DirectReactionContent = {
  messages: ChatMessage[]
}

export type SessionContent = SynthesisContent | DirectReactionContent | ChatContent
