import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

export default function Modal({ title, eyebrow, onClose, children, wide }: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`modal-panel ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <div>
            {eyebrow && <span className="modal-eyebrow">{eyebrow}</span>}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  )
}
