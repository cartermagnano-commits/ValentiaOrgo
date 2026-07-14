'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface Toast { id: number; message: string; kind: ToastKind }

interface ToastApi {
  notify: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastApi>({ notify: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const notify = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, kind }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4200)
  }, [])

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map(t => {
          const Icon = ICONS[t.kind]
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <Icon size={16} className="toast-icon" />
              <span className="toast-msg">{t.message}</span>
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
