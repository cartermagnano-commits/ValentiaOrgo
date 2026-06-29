'use client'

import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export default function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-button" onClick={onClose} aria-label="Close modal">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
