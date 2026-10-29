import {
  Braces, Check, ChevronRight, Clipboard, Code2, Cpu, Database, Expand,
  FilePlus2, Gauge, HardDrive, Keyboard, Maximize2, Monitor,
  MousePointer2, Pause, Play, Power, RotateCcw, Save, ShieldCheck,
  SquareTerminal, Trash2, Upload, X,
} from 'lucide-react'
import {
  useCallback, useEffect, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type KeyboardEvent,
  type PointerEvent, type WheelEvent,
} from 'react'
import Modal from './Modal'
import OnScreenKeyboard from './OnScreenKeyboard'
import { cacheLocalImage, decompressGzip, formatBytes, loadBundledImage } from '../vm/images'
import { CTRL_ALT_DELETE, scancodesForKey, serialForKey } from '../vm/input'
import {
  clearImageCache, clearSnapshots, deleteSnapshot, getCacheInfo, getCachedImage,
  getSnapshot, saveSnapshot, snapshotKey,
} from '../vm/storage'
import type {
  BootStage, CacheInfo, LinuxVariant, MainToWorkerMessage, SchedulerProfile,
  SnapshotRecord, VMMode, VMStats, VMStatus, WorkerToMainMessage,
} from '../vm/types'

const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
const EMPTY_STATS: VMStats = {
  instructions: 0, mips: 0, fps: 0, frames: 0, uptimeSeconds: 0,
  schedulerDelay: 0, frameCap: 30, memoryMB: 0,
}
const EMPTY_CACHE: CacheInfo = { images: 0, imageBytes: 0, snapshots: 0, snapshotBytes: 0 }
const STAGE_TEXT: Record<BootStage, string> = {
  idle: 'Machine is ready when you are.',
  image: 'Reading the boot image from local storage…',
  restore: 'Restoring real CPU, memory, and device state…',
  bios: 'SeaBIOS is initializing virtual hardware…',
  bootloader: 'Firmware handoff received; bootloader is running…',
  os: 'Kernel control detected; waiting for guest display…',
  ready: 'Guest display is active.',
  error: 'The virtual machine stopped on an error.',
}
const SCHEDULER_DELAY: Record<SchedulerProfile, number> = { focus: 0, balanced: 2, background: 24, battery: 6 }

interface LogEntry { id: number; time: string; text: string }
interface StartOptions { resume?: ArrayBuffer; image?: File; coldBoot?: boolean; bundled?: boolean }

export default function LocalSystemVM() {
  const [mode, setMode] = useState<VMMode>('linux')
  const [variant, setVariant] = useState<LinuxVariant>('desktop')
  const [status, setStatus] = useState<VMStatus>('idle')
  const [stage, setStage] = useState<BootStage>('idle')
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState(STAGE_TEXT.idle)
  const [stats, setStats] = useState<VMStats>(EMPTY_STATS)
  const [serial, setSerial] = useState('')
  const [textLines, setTextLines] = useState<string[]>([])
  const [graphical, setGraphical] = useState(false)
  const [bootMs, setBootMs] = useState<number | null>(null)
  const [instantRestore, setInstantRestore] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<CacheInfo>(EMPTY_CACHE)
  const [snapshot, setSnapshot] = useState<SnapshotRecord | null>(null)
  const [xpImage, setXpImage] = useState<File | null>(null)
  const [customLinuxImage, setCustomLinuxImage] = useState<File | null>(null)
  const [activeTab, setActiveTab] = useState<'runtime' | 'images' | 'input'>('runtime')
  const [scheduler, setScheduler] = useState<SchedulerProfile>('focus')
  const [batteryMode, setBatteryMode] = useState(false)
  const [pointerLocked, setPointerLocked] = useState(false)
  const [theater, setTheater] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [embedOpen, setEmbedOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [toast, setToast] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])

  const workerRef = useRef<Worker | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const machineRef = useRef<HTMLElement>(null)
  const terminalRef = useRef<HTMLPreElement>(null)
  const modeRef = useRef<VMMode>('linux')
  const variantRef = useRef<LinuxVariant>('desktop')
  const stageRef = useRef<BootStage>('idle')
  const imageFileRef = useRef<File | null>(null)
  const startSequenceRef = useRef(0)
  const requestIdRef = useRef(0)
  const logIdRef = useRef(0)
  const pendingRef = useRef(new Map<number, { resolve: (buffer: ArrayBuffer) => void; reject: (error: Error) => void }>())
  const sharedControlRef = useRef<SharedArrayBuffer | null>(null)
  const schedulerRef = useRef<SchedulerProfile>('focus')
  const mouseButtonsRef = useRef({ left: false, middle: false, right: false })
  const lastMouseMoveRef = useRef(0)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isConsole = mode === 'linux' && variant === 'console' && !customLinuxImage
  const canControl = status === 'running' || status === 'paused' || status === 'booting'
  const isolated = typeof window !== 'undefined' && window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 3200)
  }, [])

  const addLog = useCallback((text: string) => {
    const entry = { id: ++logIdRef.current, time: new Date().toLocaleTimeString([], { hour12: false }), text }
    setLogs(previous => [entry, ...previous].slice(0, 7))
  }, [])

  const refreshCache = useCallback(async () => {
    try { setCacheInfo(await getCacheInfo()) } catch { setCacheInfo(EMPTY_CACHE) }
  }, [])

  const applyStage = useCallback((nextStage: BootStage, nextProgress?: number, measuredMs?: number) => {
    stageRef.current = nextStage
    setStage(nextStage)
    if (typeof nextProgress === 'number') setProgress(nextProgress)
    setStatusMessage(STAGE_TEXT[nextStage])
    if (nextStage === 'ready') {
      setStatus('running')
      if (typeof measuredMs === 'number' && measuredMs > 0) setBootMs(measuredMs)
    } else if (nextStage === 'error') {
      setStatus('error')
    } else if (nextStage !== 'idle') {
      setStatus(current => current === 'loading' ? current : 'booting')
    }
  }, [])

  const post = useCallback((message: MainToWorkerMessage) => {
    workerRef.current?.postMessage(message)
  }, [])

  const handleWorkerMessage = useCallback((message: WorkerToMainMessage) => {
    switch (message.type) {
      case 'serial':
        setSerial(previous => `${previous}${message.text || ''}`.slice(-80000))
        break
      case 'text-screen':
        setTextLines(message.lines || [])
        break
      case 'display-mode':
        setGraphical(!!message.graphical)
        if (canvasRef.current && message.width && message.height) {
          canvasRef.current.width = message.width
          canvasRef.current.height = message.height
        }
        break
      case 'display-size':
        if (canvasRef.current && message.width && message.height) {
          canvasRef.current.width = message.width
          canvasRef.current.height = message.height
        }
        break
      case 'frame': {
        const canvas = canvasRef.current
        if (!canvas) break
        if (message.width && message.height && (canvas.width !== message.width || canvas.height !== message.height)) {
          canvas.width = message.width
          canvas.height = message.height
        }
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) break
        context.imageSmoothingEnabled = false
        for (const layer of message.layers || []) {
          if (!layer.buffer || !layer.width || !layer.height) continue
          const pixels = new Uint8ClampedArray(layer.buffer)
          context.putImageData(new ImageData(pixels, layer.width, layer.height), layer.screenX, layer.screenY)
        }
        break
      }
      case 'stage':
        applyStage(message.stage || 'idle', message.progress, message.bootMs)
        if (message.stage === 'ready') addLog(`Guest display active${message.bootMs ? ` in ${(message.bootMs / 1000).toFixed(1)} s` : ''}.`)
        break
      case 'status':
        if (message.status === 'paused') setStatus('paused')
        else if (message.status === 'running') setStatus(stageRef.current === 'ready' ? 'running' : 'booting')
        else if (message.status === 'booting' && stageRef.current !== 'ready') setStatus('booting')
        else if (message.status === 'idle') setStatus('idle')
        break
      case 'stats':
        if (message.stats) setStats(message.stats)
        break
      case 'asset-progress':
        if (typeof message.progress === 'number') setProgress(Math.max(8, Math.round(message.progress * 22)))
        break
      case 'warning':
        if (message.text) addLog(message.text)
        break
      case 'state-saved': {
        const pending = message.id ? pendingRef.current.get(message.id) : undefined
        if (pending && message.buffer) {
          pending.resolve(message.buffer)
          pendingRef.current.delete(message.id!)
        }
        break
      }
      case 'error': {
        const error = new Error(message.error || 'Unknown worker error')
        if (message.id && pendingRef.current.has(message.id)) {
          pendingRef.current.get(message.id)?.reject(error)
          pendingRef.current.delete(message.id)
        } else {
          setStatus('error')
          applyStage('error', 100)
          setStatusMessage(error.message)
          addLog(error.message)
        }
        break
      }
    }
  }, [addLog, applyStage])

  const startMachine = useCallback(async (nextMode: VMMode = mode, nextVariant: LinuxVariant = variant, options: StartOptions = {}) => {
    const sequence = ++startSequenceRef.current
    workerRef.current?.terminate()
    workerRef.current = null
    pendingRef.current.forEach(pending => pending.reject(new Error('Machine was restarted.')))
    pendingRef.current.clear()
    sharedControlRef.current = null
    modeRef.current = nextMode
    variantRef.current = nextVariant
    setMode(nextMode)
    setVariant(nextVariant)
    setStatus('loading')
    setSerial('')
    setTextLines([])
    setGraphical(false)
    setStats({ ...EMPTY_STATS, memoryMB: nextMode === 'xp' ? 512 : nextMode === 'dos' ? 32 : nextVariant === 'desktop' ? 256 : 128 })
    setSnapshot(null)
    setBootMs(null)
    setInstantRestore(false)
    applyStage('image', 2)
    addLog(`Preparing ${nextMode === 'linux' ? 'Linux' : nextMode === 'xp' ? 'Windows XP' : 'DOS games'}; worker CPU, no relay.`)

    try {
      let image: File | undefined = options.image
      if (nextMode === 'xp' && !image) image = xpImage || await getCachedImage('user-xp-hda')
      if (nextMode === 'linux' && !image && customLinuxImage && !options.bundled) image = customLinuxImage
      if (nextMode === 'xp' && !image) {
        if (sequence !== startSequenceRef.current) return
        setStatus('idle')
        setStage('idle')
        stageRef.current = 'idle'
        setProgress(0)
        setStatusMessage('Choose a licensed, installed Windows XP raw disk image to boot.')
        return
      }
      if (nextMode === 'linux' && !image) {
        const desktop = nextVariant === 'desktop'
        const result = await loadBundledImage(
          desktop ? 'bundled-linux-desktop' : 'bundled-linux-console',
          asset(desktop ? 'images/linux-desktop.iso' : 'images/demo-linux.iso'),
          desktop ? 'linux-desktop.iso' : 'demo-linux.iso',
          (loaded, total) => {
            if (sequence !== startSequenceRef.current) return
            setStatusMessage(total ? `Loading Linux image · ${formatBytes(loaded)} / ${formatBytes(total)}` : `Loading Linux image · ${formatBytes(loaded)}`)
            setProgress(total ? Math.min(20, Math.round(loaded / total * 20)) : 4)
          },
        )
        image = result.file
        addLog(result.cached ? 'Linux image read from IndexedDB; no download needed.' : 'Linux image downloaded once and persisted locally.')
      } else if (nextMode === 'dos' && !image) {
        const result = await loadBundledImage('bundled-dos-games', asset('images/dos-games.img'), 'dos-games.img', (loaded, total) => {
          if (sequence !== startSequenceRef.current) return
          setProgress(total ? Math.min(20, Math.round(loaded / total * 20)) : 8)
          setStatusMessage(`Loading FreeDOS + games · ${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ''}`)
        })
        image = result.file
        addLog(result.cached ? 'DOS floppy restored from local cache.' : 'DOS floppy cached for instant repeat boots.')
      }
      if (!image || sequence !== startSequenceRef.current) return
      imageFileRef.current = image
      const key = snapshotKey(nextMode, nextVariant, image.name)
      const saved = await getSnapshot(key)
      if (sequence !== startSequenceRef.current) return
      setSnapshot(saved || null)

      let resumeBuffer = options.resume
      const useInstantDesktop = nextMode === 'linux' && nextVariant === 'desktop' && !options.coldBoot && !resumeBuffer && !options.image && (options.bundled || !customLinuxImage)
      if (useInstantDesktop) {
        try {
          setStatusMessage('Loading the compressed instant-desktop state…')
          const stateImage = await loadBundledImage(
            'bundled-linux-desktop-state',
            asset('images/linux-desktop-state.bin'),
            'linux-desktop-state.bin',
            (loaded, total) => {
              if (sequence !== startSequenceRef.current) return
              setProgress(total ? 20 + Math.min(12, Math.round(loaded / total * 12)) : 22)
            },
          )
          setStatusMessage('Decompressing real CPU, memory, and device state…')
          resumeBuffer = await decompressGzip(stateImage.file)
          addLog(stateImage.cached ? 'Instant desktop state restored from local cache.' : 'Instant desktop state cached for repeat visits.')
        } catch (error) {
          addLog(`${error instanceof Error ? error.message : String(error)} Falling back to cold boot.`)
        }
      }
      if (sequence !== startSequenceRef.current) return
      setInstantRestore(!!resumeBuffer)

      const worker = new Worker(asset('v86/vm-worker.js'))
      workerRef.current = worker
      worker.onmessage = event => handleWorkerMessage(event.data as WorkerToMainMessage)
      worker.onerror = event => {
        setStatus('error')
        applyStage('error', 100)
        setStatusMessage(event.message || 'The emulator worker failed to start.')
      }
      let sharedBuffer: SharedArrayBuffer | undefined
      if (window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
        sharedBuffer = new SharedArrayBuffer(4)
        sharedControlRef.current = sharedBuffer
        new Int32Array(sharedBuffer)[0] = SCHEDULER_DELAY[schedulerRef.current]
      }
      const config = {
        mode: nextMode,
        variant: nextVariant,
        memoryMB: nextMode === 'xp' ? 512 : nextMode === 'dos' ? 32 : nextVariant === 'desktop' ? 256 : 128,
        vgaMemoryMB: nextMode === 'xp' || nextMode === 'linux' && nextVariant === 'desktop' ? 8 : 4,
        assetRoot: asset('v86/'),
        image,
        snapshot: resumeBuffer,
        scheduler: schedulerRef.current,
      }
      setStatus('booting')
      worker.postMessage({ type: 'start', config, sharedBuffer } satisfies MainToWorkerMessage)
    } catch (error) {
      if (sequence !== startSequenceRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setStatus('error')
      applyStage('error', 100)
      setStatusMessage(message)
      addLog(message)
    }
  }, [addLog, applyStage, customLinuxImage, handleWorkerMessage, mode, variant, xpImage])

  useEffect(() => {
    void refreshCache()
    void getCachedImage('user-xp-hda').then(file => file && setXpImage(file))
    void getCachedImage('user-linux-image').then(file => file && setCustomLinuxImage(file))
    addLog('Local runtime initialized. No backend or streaming transport configured.')
    void startMachine('linux', 'desktop')
    return () => {
      startSequenceRef.current += 1
      workerRef.current?.terminate()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
    // The machine intentionally boots once, immediately, on the first page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [serial])

  useEffect(() => {
    const effective: SchedulerProfile = batteryMode ? 'battery' : 'focus'
    schedulerRef.current = effective
    setScheduler(effective)
    post({ type: 'scheduler', scheduler: effective })
    if (sharedControlRef.current) new Int32Array(sharedControlRef.current)[0] = SCHEDULER_DELAY[effective]
  }, [batteryMode, post])

  useEffect(() => {
    const update = () => {
      const effective: SchedulerProfile = document.hidden || !document.hasFocus()
        ? 'background'
        : batteryMode ? 'battery' : 'focus'
      schedulerRef.current = effective
      setScheduler(effective)
      post({ type: 'scheduler', scheduler: effective })
      if (sharedControlRef.current) new Int32Array(sharedControlRef.current)[0] = SCHEDULER_DELAY[effective]
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [batteryMode, post])

  useEffect(() => {
    const update = () => setPointerLocked(document.pointerLockElement === screenRef.current)
    document.addEventListener('pointerlockchange', update)
    return () => document.removeEventListener('pointerlockchange', update)
  }, [])

  const togglePause = useCallback(() => {
    if (status === 'paused') {
      post({ type: 'resume' })
      setStatus('running')
      addLog('Emulation resumed.')
    } else if (status === 'running' || status === 'booting') {
      post({ type: 'pause' })
      setStatus('paused')
      addLog('Emulation paused; host scheduling released.')
    }
  }, [addLog, post, status])

  const requestState = useCallback((): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) return reject(new Error('No active emulator worker.'))
      const id = ++requestIdRef.current
      pendingRef.current.set(id, { resolve, reject })
      worker.postMessage({ type: 'save-state', id })
    })
  }, [])

  const suspend = useCallback(async () => {
    if (!imageFileRef.current || !workerRef.current || status === 'saving') return
    const previousStatus = status
    setStatus('saving')
    setStatusMessage('Serializing CPU, memory, devices, and dirty disk blocks…')
    try {
      const buffer = await requestState()
      const record: SnapshotRecord = {
        key: snapshotKey(modeRef.current, variantRef.current, imageFileRef.current.name),
        mode: modeRef.current,
        variant: variantRef.current,
        imageName: imageFileRef.current.name,
        imageSize: imageFileRef.current.size,
        createdAt: Date.now(),
        buffer,
      }
      await saveSnapshot(record)
      setSnapshot(record)
      setStatusMessage(`Snapshot saved locally · ${formatBytes(buffer.byteLength)}.`)
      addLog(`Snapshot persisted in IndexedDB (${formatBytes(buffer.byteLength)}).`)
      showToast('Machine state saved in this browser.')
      void refreshCache()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(message)
      showToast(message)
    } finally {
      setStatus(previousStatus)
    }
  }, [refreshCache, requestState, showToast, status])

  const resumeSnapshot = useCallback(() => {
    if (snapshot?.buffer) void startMachine(mode, variant, { resume: snapshot.buffer })
  }, [mode, snapshot, startMachine, variant])

  const removeSnapshot = useCallback(async () => {
    if (!snapshot) return
    await deleteSnapshot(snapshot.key)
    setSnapshot(null)
    showToast('Snapshot deleted. The boot image is unchanged.')
    void refreshCache()
  }, [refreshCache, showToast, snapshot])

  const selectXPImage = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 4 * 1024 * 1024 * 1024) {
      showToast('Choose a raw XP disk smaller than 4 GB for this browser profile.')
      return
    }
    setXpImage(file)
    await cacheLocalImage('user-xp-hda', file)
    addLog(`Licensed XP image selected: ${file.name} (${formatBytes(file.size)}).`)
    void startMachine('xp', 'desktop', { image: file })
  }, [addLog, showToast, startMachine])

  const selectLinuxImage = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setCustomLinuxImage(file)
    await cacheLocalImage('user-linux-image', file)
    addLog(`Custom Linux image selected: ${file.name} (${formatBytes(file.size)}).`)
    void startMachine('linux', 'desktop', { image: file })
  }, [addLog, startMachine])

  const switchMode = useCallback((nextMode: VMMode) => {
    if (nextMode === 'linux') void startMachine('linux', variant, { image: customLinuxImage || undefined })
    else void startMachine(nextMode, 'desktop')
  }, [customLinuxImage, startMachine, variant])

  const switchLinuxVariant = useCallback((nextVariant: LinuxVariant) => {
    setCustomLinuxImage(null)
    void startMachine('linux', nextVariant, { bundled: true })
  }, [startMachine])

  const pasteIntoVM = useCallback((text: string) => {
    if (!text) return
    post({ type: isConsole ? 'serial' : 'text', text })
    screenRef.current?.focus()
    addLog(`Pasted ${text.length} characters through the guest input channel.`)
  }, [addLog, isConsole, post])

  const readClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) pasteIntoVM(text)
      else showToast('The clipboard is empty. Use the paste panel for manual input.')
    } catch {
      setPasteValue('')
      setPasteOpen(true)
    }
  }, [pasteIntoVM, showToast])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!canControl) return
    if (isConsole) {
      const text = serialForKey(event.nativeEvent)
      if (text) {
        event.preventDefault()
        post({ type: 'serial', text })
      }
      return
    }
    const codes = scancodesForKey(event.code, true)
    if (codes.length) {
      event.preventDefault()
      post({ type: 'key', codes })
    }
  }, [canControl, isConsole, post])

  const handleKeyUp = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (isConsole) return
    const codes = scancodesForKey(event.code, false)
    if (codes.length) {
      event.preventDefault()
      post({ type: 'key', codes })
    }
  }, [isConsole, post])

  const sendVirtualKey = useCallback((code: string, down: boolean) => {
    if (isConsole) {
      if (!down) return
      const keys: Record<string, string> = {
        Escape: '\x1b', Tab: '\t', Enter: '\n', Backspace: '\x7f', Space: ' ',
        ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
        ControlLeft: '\x03',
      }
      if (keys[code]) post({ type: 'serial', text: keys[code] })
    } else {
      const codes = scancodesForKey(code, down)
      if (codes.length) post({ type: 'key', codes })
    }
  }, [isConsole, post])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!canControl) return
    const now = performance.now()
    if (now - lastMouseMoveRef.current < 16) return
    lastMouseMoveRef.current = now
    const target = canvasRef.current || screenRef.current
    if (!target) return
    const rect = target.getBoundingClientRect()
    const locked = document.pointerLockElement === screenRef.current
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    post({
      type: 'mouse-move',
      deltaX: locked ? event.movementX : 0,
      deltaY: locked ? event.movementY : 0,
      x: locked ? undefined : x / Math.max(1, rect.width) * (canvasRef.current?.width || 640),
      y: locked ? undefined : y / Math.max(1, rect.height) * (canvasRef.current?.height || 480),
      width: locked ? undefined : canvasRef.current?.width || 640,
      height: locked ? undefined : canvasRef.current?.height || 480,
    })
  }, [canControl, post])

  const updateMouseButton = useCallback((event: PointerEvent<HTMLDivElement>, down: boolean) => {
    if (!canControl) return
    event.preventDefault()
    screenRef.current?.focus()
    if (down) event.currentTarget.setPointerCapture(event.pointerId)
    if (event.button === 0) mouseButtonsRef.current.left = down
    if (event.button === 1) mouseButtonsRef.current.middle = down
    if (event.button === 2) mouseButtonsRef.current.right = down
    post({ type: 'mouse-click', ...mouseButtonsRef.current })
  }, [canControl, post])

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!canControl) return
    event.preventDefault()
    post({ type: 'mouse-wheel', wheel: event.deltaY > 0 ? -1 : 1 })
  }, [canControl, post])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    pasteIntoVM(event.clipboardData.getData('text/plain'))
  }, [pasteIntoVM])

  const togglePointerLock = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock()
    else if (screenRef.current?.requestPointerLock) screenRef.current.requestPointerLock()
    else showToast('Pointer lock is unavailable here; touch and absolute mouse mapping remain active.')
  }, [showToast])

  const toggleFullscreen = useCallback(async () => {
    if (theater) {
      setTheater(false)
      return
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (machineRef.current?.requestFullscreen) {
      try { await machineRef.current.requestFullscreen() } catch { setTheater(true) }
    } else {
      setTheater(true)
    }
  }, [theater])

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast('Copied to clipboard.')
    } catch {
      showToast('Clipboard permission was denied; select the code block manually.')
    }
  }, [showToast])

  const clearImages = useCallback(async () => {
    await clearImageCache()
    setCacheInfo(previous => ({ ...previous, images: 0, imageBytes: 0 }))
    showToast('Downloaded images and service-worker cache cleared.')
  }, [showToast])

  const clearAllSnapshots = useCallback(async () => {
    await clearSnapshots()
    setSnapshot(null)
    showToast('All local VM snapshots deleted.')
    void refreshCache()
  }, [refreshCache, showToast])

  const embedCode = `<iframe\n  src="${window.location.origin}${window.location.pathname}?embed=1&mode=linux"\n  title="Local System browser VM"\n  style="width:100%;height:760px;border:0"\n  allow="fullscreen; clipboard-read; clipboard-write; cross-origin-isolated"\n></iframe>`
  const reactCode = `import LocalSystemVM from './components/LocalSystemVM'\n\nexport default function MyKimiPage() {\n  return <LocalSystemVM />\n}`
  const headerCode = `Cross-Origin-Opener-Policy: same-origin\nCross-Origin-Embedder-Policy: require-corp\nCross-Origin-Resource-Policy: cross-origin`

  return (
    <div className={`vm-app ${window.location.search.includes('embed=1') ? 'embed-mode' : ''}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div>
            <div className="brand-name">LOCAL/SYSTEM</div>
            <div className="brand-subtitle">BROWSER-NATIVE X86 WORKSTATION</div>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="local-badge"><ShieldCheck size={14} /> LOCAL ONLY</span>
          <button className="text-button" onClick={() => setEmbedOpen(true)}><Code2 size={16} /> Embed</button>
          <button className="text-button" onClick={() => setGuideOpen(true)}><Braces size={16} /> Build guide</button>
        </div>
      </header>

      <nav className="modebar" aria-label="Virtual machine mode">
        <div className="mode-selector">
          <button className={mode === 'linux' ? 'mode-button active' : 'mode-button'} onClick={() => switchMode('linux')}>
            <SquareTerminal size={18} /><span>Linux <small>(smooth)</small></span><ChevronRight size={15} />
          </button>
          <button className={mode === 'xp' ? 'mode-button active' : 'mode-button'} onClick={() => switchMode('xp')}>
            <Monitor size={18} /><span>Windows XP</span><ChevronRight size={15} />
          </button>
          <button className={mode === 'dos' ? 'mode-button active' : 'mode-button'} onClick={() => switchMode('dos')}>
            <Power size={18} /><span>DOS games</span><ChevronRight size={15} />
          </button>
        </div>
        <div className="mode-meta">
          <span className={isolated ? 'isolation-state enabled' : 'isolation-state'}><span className="status-dot" />{isolated ? 'SAB + ATOMICS ENABLED' : 'WORKER FALLBACK'}</span>
          <span>NO CLOUD CPU</span>
        </div>
      </nav>

      <main className="workspace">
        <section ref={machineRef} className={`machine-shell ${theater ? 'theater' : ''}`} aria-label="Virtual machine window">
          <header className="machine-toolbar">
            <div className="machine-title">
              <span className={`machine-led ${status === 'running' ? 'running' : status === 'error' ? 'error' : ''}`} />
              <div><strong>{mode === 'linux' ? customLinuxImage ? 'Custom Linux' : variant === 'desktop' ? 'Tiny Core Linux' : 'Buildroot console' : mode === 'xp' ? 'Windows XP' : 'FreeDOS arcade'}</strong><span>{imageFileRef.current?.name || (mode === 'xp' ? 'NO DISK INSERTED' : 'LOCAL IMAGE')}</span></div>
            </div>
            <div className="machine-actions">
              <button className="tool-button" onClick={togglePause} disabled={!canControl} aria-label={status === 'paused' ? 'Resume machine' : 'Pause machine'}>{status === 'paused' ? <Play size={17} /> : <Pause size={17} />}<span>{status === 'paused' ? 'Resume' : 'Pause'}</span></button>
              <button className="tool-button" onClick={() => void startMachine(mode, variant)} disabled={status === 'loading' || status === 'saving'} aria-label="Reset machine"><RotateCcw size={16} /><span>Reset</span></button>
              <button className="tool-button" onClick={() => void suspend()} disabled={!canControl} aria-label="Save machine state"><Save size={16} /><span>{status === 'saving' ? 'Saving' : 'Suspend'}</span></button>
              <button className="tool-button" onClick={resumeSnapshot} disabled={!snapshot || status === 'loading' || status === 'saving'} aria-label="Restore saved machine state"><Play size={16} /><span>Restore</span></button>
              <button className="tool-button icon-only" onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen">{theater ? <X size={18} /> : <Maximize2 size={17} />}</button>
            </div>
          </header>

          <div className="display-bezel">
            <div className="bezel-corner top-left" /><div className="bezel-corner top-right" />
            <div
              ref={screenRef}
              className={`vm-screen ${pointerLocked ? 'pointer-locked' : ''}`}
              tabIndex={0}
              role="application"
              aria-label="Guest display. Click to capture keyboard and mouse input."
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onPointerMove={handlePointerMove}
              onPointerDown={event => updateMouseButton(event, true)}
              onPointerUp={event => updateMouseButton(event, false)}
              onPointerCancel={event => updateMouseButton(event, false)}
              onWheel={handleWheel}
              onPaste={handlePaste}
              onContextMenu={event => event.preventDefault()}
            >
              <canvas ref={canvasRef} className={`guest-canvas ${!graphical || isConsole ? 'hidden' : ''}`} width={640} height={480} />
              {isConsole ? (
                <pre ref={terminalRef} className="terminal-output">{serial || 'Waiting for serial console output…\n'}</pre>
              ) : !graphical ? (
                <pre className="vga-text">{textLines.join('\n')}</pre>
              ) : null}
              <div className="scanlines" aria-hidden="true" />

              {(status === 'loading' || status === 'booting' || status === 'error' || status === 'idle' || status === 'saving') && (
                <div className="boot-overlay">
                  {status === 'idle' && mode === 'xp' ? (
                    <div className="empty-machine">
                      <HardDrive size={34} />
                      <span className="boot-kicker">LICENSED MEDIA REQUIRED</span>
                      <h2>Insert your Windows XP disk.</h2>
                      <p>Use an installed raw <code>.img</code> disk. The file is read locally and never uploaded.</p>
                      <label className="primary-button" htmlFor="xp-disk-input"><Upload size={17} /> Choose XP image</label>
                      <input id="xp-disk-input" className="visually-hidden" type="file" accept=".img,.iso,application/octet-stream" onChange={selectXPImage} />
                      <small>Standard PC · 512 MB RAM · lazy disk reads</small>
                    </div>
                  ) : status === 'error' ? (
                    <div className="empty-machine">
                      <span className="boot-kicker error-text">MACHINE HALTED</span>
                      <h2>Boot did not complete.</h2>
                      <p>{statusMessage}</p>
                      <button className="primary-button" onClick={() => void startMachine(mode, variant)}><RotateCcw size={17} /> Retry boot</button>
                    </div>
                  ) : (
                    <div className="boot-sequence">
                      <div className="boot-symbol" aria-hidden="true"><span>&gt;_</span></div>
                      <span className="boot-kicker">{status === 'saving' ? 'SUSPENDING MACHINE' : instantRestore ? 'INSTANT DESKTOP RESTORE' : 'COLD BOOT SEQUENCE'}</span>
                      <h2>{mode === 'linux' ? instantRestore ? 'A real desktop. No cold-boot wait.' : 'Linux, without the data center.' : mode === 'xp' ? 'Starting a little nostalgia.' : 'Small disk. Good games.'}</h2>
                      <div className="boot-stages" aria-label="Boot stages">
                        {(instantRestore ? ['image', 'restore', 'os'] as BootStage[] : ['bios', 'bootloader', 'os'] as BootStage[]).map((item, index) => {
                          const order = instantRestore ? ['image', 'restore', 'os', 'ready'] : ['image', 'bios', 'bootloader', 'os', 'ready']
                          const done = order.indexOf(stage) > order.indexOf(item) || stage === 'ready'
                          const active = stage === item || stage === 'image' && index === 0
                          const label = item === 'bios' ? 'BIOS' : item === 'bootloader' ? 'BOOTLOADER' : item === 'restore' ? 'STATE' : item === 'image' ? 'IMAGE' : 'OS'
                          return <span key={item} className={done ? 'done' : active ? 'active' : ''}>{done ? <Check size={13} /> : <span className="stage-index">0{index + 1}</span>}{label}</span>
                        })}
                      </div>
                      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})` }} /></div>
                      <div className="boot-status-line"><span>{statusMessage}</span><strong>{Math.round(progress)}%</strong></div>
                      <p className="boot-footnote">{instantRestore ? 'Restoring a real saved v86 desktop. Cold boot is available in Images.' : 'Real milestones from v86, guest serial output, and VGA events.'}</p>
                    </div>
                  )}
                </div>
              )}
              {status === 'paused' && <button className="paused-overlay" onClick={togglePause}><Play size={22} /> Resume machine</button>}
            </div>
            <div className="bezel-corner bottom-left" /><div className="bezel-corner bottom-right" />
          </div>

          <footer className="machine-statusbar">
            <span><span className={`machine-led ${status === 'running' ? 'running' : ''}`} />{status.toUpperCase()}</span>
            <span>{bootMs ? `${instantRestore ? 'STATE RESTORE' : 'FIRST OS FRAME'} ${(bootMs / 1000).toFixed(1)} S` : 'WORKER/WASM'}</span>
            <span className="capture-hint"><Keyboard size={14} /> Click display to capture input</span>
          </footer>
        </section>

        <aside className="inspector" aria-label="Machine inspector">
          <div className="inspector-tabs" role="tablist">
            <button role="tab" aria-selected={activeTab === 'runtime'} className={activeTab === 'runtime' ? 'active' : ''} onClick={() => setActiveTab('runtime')}>Runtime</button>
            <button role="tab" aria-selected={activeTab === 'images'} className={activeTab === 'images' ? 'active' : ''} onClick={() => setActiveTab('images')}>Images</button>
            <button role="tab" aria-selected={activeTab === 'input'} className={activeTab === 'input' ? 'active' : ''} onClick={() => setActiveTab('input')}>Input</button>
          </div>

          {activeTab === 'runtime' && <div className="inspector-content" role="tabpanel">
            <section className="inspector-section performance-section">
              <div className="section-heading"><span>LIVE THROUGHPUT</span><Gauge size={16} /></div>
              <div className="mips-readout"><strong>{stats.mips.toFixed(stats.mips >= 100 ? 0 : 2)}</strong><span>MILLION<br />INSTR / S</span></div>
              <div className="metric-grid">
                <div><span>FRAME RATE</span><strong>{stats.fps}<small> / {stats.frameCap} FPS</small></strong></div>
                <div><span>GUEST RAM</span><strong>{stats.memoryMB || (mode === 'xp' ? 512 : 128)}<small> MB</small></strong></div>
                <div><span>UPTIME</span><strong>{Math.floor(stats.uptimeSeconds / 60)}:{String(stats.uptimeSeconds % 60).padStart(2, '0')}</strong></div>
                <div><span>YIELD FLOOR</span><strong>{stats.schedulerDelay}<small> MS</small></strong></div>
              </div>
            </section>
            <section className="inspector-section">
              <div className="section-heading"><span>CPU SCHEDULER</span><Cpu size={16} /></div>
              <div className="scheduler-state"><span>{scheduler === 'background' ? 'Background throttle' : scheduler === 'battery' ? 'Battery saver' : 'Focused boost'}</span><strong>{SCHEDULER_DELAY[scheduler]} ms</strong></div>
              <p>Short yield for a responsive guest; a 24 ms floor when this tab loses focus.</p>
              <label className="toggle-row"><span><strong>Battery saver</strong><small>6 ms yield · 12 FPS cap</small></span><input type="checkbox" checked={batteryMode} onChange={event => setBatteryMode(event.target.checked)} /><span className="toggle-track" /></label>
            </section>
            <section className="inspector-section runtime-ledger">
              <div className="section-heading"><span>MACHINE LEDGER</span><Database size={15} /></div>
              <div className="ledger-row"><span>Emulator</span><strong>v86 / WebAssembly</strong></div>
              <div className="ledger-row"><span>Execution</span><strong>Dedicated worker</strong></div>
              <div className="ledger-row"><span>Isolation</span><strong>{isolated ? 'COOP + COEP' : 'Message fallback'}</strong></div>
              <div className="ledger-row"><span>Networking</span><strong>Disabled</strong></div>
            </section>
            <section className="inspector-section event-section">
              <div className="section-heading"><span>EVENT LOG</span><span className="live-label">LIVE</span></div>
              <div className="event-log">{logs.length ? logs.map(log => <div key={log.id}><time>{log.time}</time><p>{log.text}</p></div>) : <p>No machine events yet.</p>}</div>
            </section>
          </div>}

          {activeTab === 'images' && <div className="inspector-content" role="tabpanel">
            <section className="inspector-section">
              <div className="section-heading"><span>BOOT SOURCE</span><HardDrive size={16} /></div>
              {mode === 'linux' && <div className="source-switch">
                <button className={variant === 'desktop' && !customLinuxImage ? 'active' : ''} onClick={() => switchLinuxVariant('desktop')}>Desktop <small>19 MB + state</small></button>
                <button className={variant === 'console' && !customLinuxImage ? 'active' : ''} onClick={() => switchLinuxVariant('console')}>Console <small>7.4 MB</small></button>
              </div>}
              <div className="file-readout"><FilePlus2 size={18} /><div><strong>{imageFileRef.current?.name || (mode === 'xp' ? 'No image selected' : 'Preparing image…')}</strong><span>{imageFileRef.current ? formatBytes(imageFileRef.current.size) : 'Local files only'}</span></div></div>
              {mode === 'linux' && <>
                <label className="secondary-button full-width" htmlFor="linux-image-input"><Upload size={16} /> Use custom Linux image</label>
                <input id="linux-image-input" className="visually-hidden" type="file" accept=".img,.iso,application/octet-stream" onChange={selectLinuxImage} />
                {customLinuxImage && <button className="link-button" onClick={() => { setCustomLinuxImage(null); void startMachine('linux', 'desktop', { bundled: true }) }}>Return to bundled desktop</button>}
                {!customLinuxImage && variant === 'desktop' && <button className="link-button" onClick={() => void startMachine('linux', 'desktop', { coldBoot: true, bundled: true })}>Cold boot from BIOS instead</button>}
              </>}
              {mode === 'xp' && <>
                <label className="secondary-button full-width" htmlFor="xp-disk-input-inspector"><Upload size={16} /> {xpImage ? 'Replace XP image' : 'Choose XP image'}</label>
                <input id="xp-disk-input-inspector" className="visually-hidden" type="file" accept=".img,.iso,application/octet-stream" onChange={selectXPImage} />
                <p className="fine-print">Windows is not bundled. Use your own licensed, installed raw disk; XP setup is documented in the build guide.</p>
              </>}
              {mode === 'dos' && <div className="game-list"><span>PRELOADED</span><p>Tetris · Snake · Minesweeper<br />Invaders · Jumper · Rogue</p><code>invaders</code><code>snake</code><code>tetris</code></div>}
            </section>
            <section className="inspector-section">
              <div className="section-heading"><span>SUSPEND / RESUME</span><Save size={16} /></div>
              {snapshot ? <>
                <div className="snapshot-card"><span className="status-dot" /><div><strong>{formatBytes(snapshot.buffer.byteLength)} snapshot</strong><span>{new Date(snapshot.createdAt).toLocaleString()}</span></div></div>
                <button className="primary-button full-width" onClick={resumeSnapshot}><Play size={16} /> Restore this state</button>
                <button className="link-button danger" onClick={() => void removeSnapshot()}><Trash2 size={14} /> Delete snapshot</button>
              </> : <p>No snapshot for this exact mode and image. Choose <strong>Suspend</strong> while the guest is running.</p>}
            </section>
            <section className="inspector-section">
              <div className="section-heading"><span>BROWSER STORAGE</span><Database size={16} /></div>
              <div className="storage-numbers"><div><strong>{formatBytes(cacheInfo.imageBytes)}</strong><span>{cacheInfo.images} cached images</span></div><div><strong>{formatBytes(cacheInfo.snapshotBytes)}</strong><span>{cacheInfo.snapshots} snapshots</span></div></div>
              <p>IndexedDB + service worker. This browser only; clearing site data removes it.</p>
              <div className="button-pair"><button className="secondary-button" onClick={() => void clearImages()}>Clear images</button><button className="secondary-button" onClick={() => void clearAllSnapshots()}>Clear states</button></div>
            </section>
          </div>}

          {activeTab === 'input' && <div className="inspector-content" role="tabpanel">
            <section className="inspector-section">
              <div className="section-heading"><span>INPUT CAPTURE</span><MousePointer2 size={16} /></div>
              <p>Click the guest display for full keyboard capture. Escape releases pointer lock.</p>
              <button className="secondary-button full-width" onClick={togglePointerLock}><MousePointer2 size={16} />{pointerLocked ? 'Release pointer lock' : 'Capture pointer'}</button>
              <button className="secondary-button full-width" onClick={() => void readClipboard()}><Clipboard size={16} /> Paste from clipboard</button>
              {!isConsole && <button className="secondary-button full-width" onClick={() => post({ type: 'key', codes: CTRL_ALT_DELETE })}><Keyboard size={16} /> Send Ctrl + Alt + Del</button>}
            </section>
            <section className="inspector-section">
              <div className="section-heading"><span>TOUCH KEYS</span><Keyboard size={16} /></div>
              <OnScreenKeyboard onKey={sendVirtualKey} />
              <p className="fine-print">Touch drag maps to mouse movement. Tap maps to left click; the extra keys cover terminal and DOS controls.</p>
            </section>
            <section className="inspector-section">
              <div className="section-heading"><span>DISPLAY</span><Expand size={16} /></div>
              <button className="secondary-button full-width" onClick={() => void toggleFullscreen()}><Maximize2 size={16} /> Toggle fullscreen</button>
              <p className="fine-print">VGA is software rendered. Frames are capped and copied only when the worker produces dirty rectangles.</p>
            </section>
          </div>}
        </aside>
      </main>

      <footer className="page-statusbar">
        <span><ShieldCheck size={14} /> NO SERVER · NO STREAMING · NO ACCOUNT</span>
        <span>{mode === 'linux' ? 'BEST FOR SMALL APPS & TERMINAL WORK' : mode === 'xp' ? 'NOSTALGIA MODE · PERFORMANCE VARIES BY HOST' : 'TINY & FUN · 720 KB FLOPPY'}</span>
        <button onClick={() => setGuideOpen(true)}>PERFORMANCE & LIMITS <ChevronRight size={14} /></button>
      </footer>

      {guideOpen && <Modal title="Build, tune, and tell the truth." eyebrow="LOCAL SYSTEM / FIELD MANUAL" onClose={() => setGuideOpen(false)} wide>
        <div className="guide-grid">
          <section><h3>What is bundled</h3><p><strong>Linux:</strong> Tiny Core 11 graphical desktop (19 MB) plus a 7.4 MB Buildroot serial demo. <strong>DOS:</strong> FreeDOS with six tiny games. <strong>XP:</strong> bring your own licensed raw disk.</p><p>The custom Buildroot recipe adds a lightweight X desktop, terminal, editor, file manager, and mpv. Run <code>bash scripts/build-linux.sh</code> on an x86 Linux host with Docker.</p></section>
          <section><h3>Honest playback target</h3><p>Small-window <strong>480p or lower</strong> is the ceiling worth attempting in Linux, using MPEG-1 or low-bitrate MPEG-4 ASP and few pixels. H.264, 720p, and modern web video are not smooth targets; expect dropped frames or a slideshow. Audio adds another CPU cost and is disabled in this worker build.</p></section>
          <section><h3>Boot-time meaning</h3><p>The displayed time is measured from worker start to the first usable guest OS display event—not a fabricated progress timer. BIOS and bootloader milestones come from emulator events; OS readiness comes from serial/VGA activity. Under 15 seconds is the Linux target on a current desktop, not a universal guarantee.</p></section>
          <section><h3>COOP / COEP on Kimi pages</h3><p>Preferred: set these as HTTP response headers on the published VM page. Keep all VM assets same-origin. A service-worker fallback is included for static hosting where headers cannot be edited; the first controlled reload enables isolation, and later visits retain it.</p><div className="code-block"><code>{headerCode}</code><button onClick={() => void copyText(headerCode)}>Copy</button></div><p>Without isolation, v86 still runs in its worker and uses messages. SharedArrayBuffer/Atomics are an optimization for the scheduler control channel, not a requirement for x86 emulation.</p></section>
          <section><h3>Repeat visits & persistence</h3><p>Images are stored as local File objects in IndexedDB and also cached by the service worker. Large XP disks use lazy file reads. Snapshots require the exact same image, memory size, and v86 build. Nothing syncs across devices; clearing site data removes images and states.</p></section>
          <section><h3>Complete documentation</h3><p>The exported project contains exact Buildroot, DOS, and XP preparation scripts, browser compatibility notes, embedding instructions, and license credits.</p><p><a href={asset('docs/README.md')} target="_blank" rel="noreferrer">Open the full README <ChevronRight size={14} /></a></p></section>
        </div>
      </Modal>}

      {embedOpen && <Modal title="Drop a machine into your page." eyebrow="EMBEDDABLE COMPONENT" onClose={() => setEmbedOpen(false)} wide>
        <div className="embed-layout">
          <section><h3>Same-origin iframe</h3><p>Best isolation boundary for an existing Kimi page. Publish this project, then replace the src with its public URL. Keep <code>allow="cross-origin-isolated"</code> for SharedArrayBuffer.</p><div className="code-block tall"><code>{embedCode}</code><button onClick={() => void copyText(embedCode)}>Copy</button></div></section>
          <section><h3>React component</h3><p>For a code-level Kimi page integration, copy <code>src/components</code>, <code>src/vm</code>, the public assets, and the local font imports. The component owns its worker and cleans it up on unmount.</p><div className="code-block tall"><code>{reactCode}</code><button onClick={() => void copyText(reactCode)}>Copy</button></div></section>
        </div>
      </Modal>}

      {pasteOpen && <Modal title="Paste into the guest" eyebrow="CLIPBOARD FALLBACK" onClose={() => setPasteOpen(false)}>
        <p>Your browser denied direct clipboard reading. Paste text below, then send it through the guest keyboard/serial channel.</p>
        <textarea className="paste-textarea" value={pasteValue} onChange={event => setPasteValue(event.target.value)} placeholder="Paste or type text here" autoFocus />
        <button className="primary-button full-width" disabled={!pasteValue} onClick={() => { pasteIntoVM(pasteValue); setPasteOpen(false) }}><Clipboard size={16} /> Send to virtual machine</button>
      </Modal>}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
