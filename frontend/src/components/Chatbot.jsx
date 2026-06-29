import { useEffect, useRef, useState } from 'react'
import { streamChat } from '../api'

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

    // Add user message then a blank assistant message to stream into
    const userMessages = [...messages, { role: 'user', content: text }]
    setMessages([...userMessages, { role: 'assistant', content: '' }])
    setLoading(true)

    try {
      const ctx = buildContext(branch, substrateSMILES)
      await streamChat(
        userMessages.slice(1), // strip welcome greeting before sending
        ctx,
        delta => setMessages(prev => {
          const msgs = [...prev]
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + delta }
          return msgs
        })
      )
    } catch (e) {
      setMessages(prev => {
        const msgs = [...prev]
        msgs[msgs.length - 1] = { role: 'assistant', content: `Error: ${e.message}` }
        return msgs
      })
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
        {loading && messages[messages.length - 1]?.content === '' && (
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
