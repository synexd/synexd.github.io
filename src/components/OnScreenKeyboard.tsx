interface OnScreenKeyboardProps {
  onKey: (code: string, down: boolean) => void
}

const KEYS = [
  ['Escape', 'Esc'], ['Tab', 'Tab'], ['ControlLeft', 'Ctrl'], ['AltLeft', 'Alt'],
  ['ShiftLeft', 'Shift'], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'],
  ['ArrowRight', '→'], ['Space', 'Space'], ['Enter', 'Enter'], ['Backspace', 'Delete'],
]

export default function OnScreenKeyboard({ onKey }: OnScreenKeyboardProps) {
  return (
    <div className="screen-keyboard" aria-label="On-screen keyboard">
      {KEYS.map(([code, label]) => (
        <button
          type="button"
          key={code}
          onPointerDown={event => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            onKey(code, true)
          }}
          onPointerUp={event => {
            event.preventDefault()
            onKey(code, false)
          }}
          onPointerCancel={() => onKey(code, false)}
          onClick={event => {
            if (event.detail === 0) {
              onKey(code, true)
              onKey(code, false)
            }
          }}
        >{label}</button>
      ))}
    </div>
  )
}
