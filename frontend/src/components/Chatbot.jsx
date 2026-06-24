import { useEffect, useRef, useState } from 'react'
import { sendChat } from '../api'

function buildContext(branch, substrateSMILES) {
  if (!branch) return null
  return {
    substrate_smiles: substrateSMILES,
    reagent_name: branch.reagent.name,
    reagent_smiles: branch.reagent.smiles,
    reaction_name: branch.reaction_classification?.name ?? 'Unknown',
    product_smiles: branch.product_smiles,
    execution_history: branch.execution_history,
  }
}

export default function Chatbot({ branch, substrateSMILES }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! Ask me anything about organic chemistry or the reaction pathway you\'re viewing.' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')

    const newMessages = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setLoading(true)

    try {
      const ctx = buildContext(branch, substrateSMILES)
      // Slice off the static welcome greeting (index 0) before sending to the API
      const result = await sendChat(newMessages.slice(1), ctx)
      setMessages(prev => [...prev, { role: 'assistant', content: result.response }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div className="panel-body" style={{ gap: 10 }}>
      {branch && (
        <div style={{
          fontSize: 10, color: 'var(--accent)', background: 'rgba(88,166,255,0.08)',
          border: '1px solid rgba(88,166,255,0.2)', borderRadius: 4, padding: '4px 8px'
        }}>
          Context: {branch.reagent.name} + {substrateSMILES}
        </div>
      )}

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && (
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
          placeholder="Ask about the reaction, mechanism, or any orgo concept…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="btn-primary"
          style={{ alignSelf: 'flex-end', padding: '8px 14px' }}
          onClick={handleSend}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
