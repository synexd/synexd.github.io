/* Local System: v86 lives entirely in this worker. No DOM, network relay, or backend. */
/* global V86, importScripts, postMessage, FileReader */
'use strict'

importScripts('./libv86.js')

let emulator = null
let configuration = null
let sharedControl = null
let schedulerDelay = 0
let frameCap = 30
let frameTimer = 0
let statsTimer = 0
let serialTimer = 0
let serialBytes = []
let serialHistory = ''
let startedAt = 0
let bootMs = 0
let currentStage = 'image'
let isGraphical = false
let screenWidth = 720
let screenHeight = 400
let lastText = ''
let renderedFrames = 0
let totalFrames = 0
let lastStatsAt = 0
let lastInstructions = 0
let schedulerInstalled = false
let schedulerPort = null
let schedulerChannel = null
let bootEnterSent = false
let screenPatched = false
const decoder = new TextDecoder('utf-8')
const stageRank = { image: 0, restore: 1, bios: 1, bootloader: 2, os: 3, ready: 4, error: 5 }

function send(message, transfer) {
  postMessage(message, transfer || [])
}

function setStage(stage) {
  if (stageRank[stage] < stageRank[currentStage]) return
  currentStage = stage
  const progress = { image: 12, restore: 34, bios: 28, bootloader: 48, os: 78, ready: 100, error: 100 }[stage]
  send({ type: 'stage', stage, progress, bootMs })
}

function noteBootActivity() {
  if (currentStage === 'bios') setStage('bootloader')
}

function markReady() {
  if (currentStage === 'ready') return
  bootMs = Math.round(performance.now() - startedAt)
  setStage('ready')
}

function installScheduler() {
  if (!emulator || !emulator.v86 || schedulerInstalled) return
  schedulerInstalled = true
  const core = emulator.v86
  schedulerChannel = new MessageChannel()
  schedulerPort = schedulerChannel.port2
  schedulerChannel.port1.onmessage = event => core.yield_callback(event.data)
  core.yield = function(t, tick) {
    const delay = sharedControl ? Atomics.load(sharedControl, 0) : schedulerDelay
    const wait = Math.max(0, t, delay)
    if (wait < 1 && schedulerPort) schedulerPort.postMessage(tick)
    else setTimeout(() => core.yield_callback(tick), wait)
  }
}

function setScheduler(profile) {
  const profiles = {
    focus: { delay: 0, fps: 30 },
    balanced: { delay: 2, fps: 20 },
    background: { delay: 24, fps: 4 },
    battery: { delay: 6, fps: 12 },
  }
  const selected = profiles[profile] || profiles.balanced
  schedulerDelay = selected.delay
  frameCap = selected.fps
  if (sharedControl) Atomics.store(sharedControl, 0, schedulerDelay)
  if (frameTimer) {
    clearInterval(frameTimer)
    frameTimer = setInterval(renderDisplay, Math.max(16, Math.floor(1000 / frameCap)))
  }
}

function flushSerial() {
  serialTimer = 0
  if (!serialBytes.length) return
  const text = decoder.decode(new Uint8Array(serialBytes))
  serialBytes = []
  send({ type: 'serial', text })
}

function copyLayer(layer) {
  const image = layer.image_data
  const source = image.data
  const width = layer.buffer_width
  const height = layer.buffer_height
  const output = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    const sourceStart = ((layer.buffer_y + row) * image.width + layer.buffer_x) * 4
    output.set(source.subarray(sourceStart, sourceStart + width * 4), row * width * 4)
  }
  return {
    buffer: output.buffer,
    width,
    height,
    screenX: layer.screen_x,
    screenY: layer.screen_y,
  }
}

function patchScreenAdapter() {
  const screen = emulator.screen_adapter
  if (!screen || screenPatched) return
  screenPatched = true
  const originalSetMode = screen.set_mode.bind(screen)
  const originalSetSize = screen.set_size_graphical.bind(screen)

  screen.set_mode = function(graphical) {
    originalSetMode(graphical)
    isGraphical = !!graphical
    noteBootActivity()
    if (graphical && currentStage !== 'ready') setStage('os')
    send({ type: 'display-mode', graphical: isGraphical, width: screenWidth, height: screenHeight })
  }
  screen.set_size_graphical = function(width, height) {
    originalSetSize(width, height)
    screenWidth = width
    screenHeight = height
    noteBootActivity()
    send({ type: 'display-size', width, height, graphical: isGraphical })
  }
  screen.update_buffer = function(layers) {
    if (!layers || !layers.length) return
    const copied = layers.map(copyLayer)
    const transfers = copied.map(layer => layer.buffer)
    renderedFrames += 1
    totalFrames += 1
    send({ type: 'frame', width: screenWidth, height: screenHeight, layers: copied }, transfers)
    if (configuration && configuration.snapshot || totalFrames >= 3) markReady()
  }
}

function renderDisplay() {
  if (!emulator || !emulator.screen_adapter || !emulator.v86) return
  try {
    if (isGraphical) {
      const vga = emulator.v86.cpu.devices.vga
      if (vga) vga.screen_fill_buffer()
    } else {
      const lines = emulator.screen_adapter.get_text_screen()
      const text = lines.join('\n')
      if (text !== lastText) {
        lastText = text
        noteBootActivity()
        send({ type: 'text-screen', lines })
        const normalized = text.toLowerCase()
        if (!bootEnterSent && configuration && configuration.mode === 'linux' && normalized.includes('press enter to boot')) {
          bootEnterSent = true
          setTimeout(() => {
            if (emulator) emulator.keyboard_send_scancodes([0x1c, 0x9c])
          }, 80)
        }
        if (normalized.includes('welcome to freedos') || normalized.includes("try 'invaders'")) markReady()
      }
    }
  } catch (error) {
    send({ type: 'warning', text: `Display bridge: ${error.message}` })
  }
}

function updateStats() {
  if (!emulator) return
  const now = performance.now()
  const instructions = emulator.get_instruction_counter()
  const elapsed = Math.max(1, now - lastStatsAt)
  const delta = (instructions - lastInstructions) >>> 0
  send({
    type: 'stats',
    stats: {
      instructions,
      mips: Math.round(delta * 1000 / elapsed / 10000) / 100,
      fps: renderedFrames,
      frames: totalFrames,
      uptimeSeconds: Math.floor((now - startedAt) / 1000),
      schedulerDelay: sharedControl ? Atomics.load(sharedControl, 0) : schedulerDelay,
      frameCap,
      memoryMB: configuration ? configuration.memoryMB : 0,
    },
  })
  renderedFrames = 0
  lastInstructions = instructions
  lastStatsAt = now
}

function imageOptions(file, async) {
  return file ? { buffer: file, async: !!async } : undefined
}

async function start(config) {
  configuration = config
  startedAt = performance.now()
  lastStatsAt = startedAt
  currentStage = 'image'
  bootMs = 0
  totalFrames = 0
  renderedFrames = 0
  serialHistory = ''
  lastText = ''
  isGraphical = false
  schedulerInstalled = false
  bootEnterSent = false
  screenPatched = false
  setScheduler(config.scheduler || 'balanced')
  setStage(config.snapshot ? 'restore' : 'bios')

  const root = config.assetRoot.endsWith('/') ? config.assetRoot : `${config.assetRoot}/`
  const options = {
    wasm_path: `${root}v86.wasm`,
    memory_size: config.memoryMB * 1024 * 1024,
    vga_memory_size: config.vgaMemoryMB * 1024 * 1024,
    bios: { url: `${root}seabios.bin` },
    vga_bios: { url: `${root}vgabios.bin` },
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    autostart: true,
    fastboot: config.mode !== 'xp',
    acpi: config.mode === 'xp' ? false : undefined,
  }

  if (config.mode === 'linux' && config.variant === 'desktop') {
    options.hda = imageOptions(config.image, false)
  } else if (config.mode === 'linux' || config.mode === 'xp' && config.image && /\.iso$/i.test(config.image.name)) {
    options.cdrom = imageOptions(config.image, config.mode === 'xp')
  } else if (config.mode === 'xp') {
    options.hda = imageOptions(config.image, true)
  } else if (config.mode === 'dos') {
    options.fda = imageOptions(config.image, false)
  }
  if (config.secondaryImage) options.fdb = imageOptions(config.secondaryImage, false)
  if (config.snapshot) options.initial_state = { buffer: config.snapshot }

  emulator = new V86(options)
  patchScreenAdapter()
  installScheduler()

  emulator.add_listener('emulator-ready', () => {
    patchScreenAdapter()
    installScheduler()
    setStage(config.snapshot ? 'restore' : 'bios')
  })
  emulator.add_listener('emulator-loaded', () => {
    patchScreenAdapter()
    installScheduler()
    if (config.snapshot) {
      const vga = emulator.v86 && emulator.v86.cpu.devices.vga
      if (vga) {
        isGraphical = !!vga.graphical_mode
        if (isGraphical) {
          screenWidth = vga.svga_width || screenWidth
          screenHeight = vga.svga_height || screenHeight
        }
        send({ type: 'display-mode', graphical: isGraphical, width: screenWidth, height: screenHeight })
        vga.complete_redraw()
        vga.screen_fill_buffer()
      }
      setStage('os')
    }
    send({ type: 'status', status: 'booting' })
  })
  emulator.add_listener('emulator-started', () => {
    installScheduler()
    send({ type: 'status', status: 'running' })
  })
  emulator.add_listener('emulator-stopped', () => send({ type: 'status', status: 'paused' }))
  emulator.add_listener('serial0-output-byte', byte => {
    serialBytes.push(byte)
    serialHistory = (serialHistory + String.fromCharCode(byte)).slice(-65536)
    noteBootActivity()
    const normalized = serialHistory.toLowerCase()
    if (normalized.includes('linux version') || normalized.includes('starting init') || normalized.includes('tiny core')) {
      if (currentStage !== 'ready') setStage('os')
    }
    if (normalized.includes('welcome to buildroot') || normalized.includes('login:') || normalized.includes('/ #') || normalized.includes('~ $') || normalized.includes('~%')) markReady()
    if (!serialTimer) serialTimer = setTimeout(flushSerial, 16)
  })
  emulator.add_listener('download-progress', event => {
    send({ type: 'asset-progress', progress: event.total ? event.loaded / event.total : 0.5, text: event.file_name })
  })

  clearInterval(frameTimer)
  frameTimer = setInterval(renderDisplay, Math.max(16, Math.floor(1000 / frameCap)))
  clearInterval(statsTimer)
  statsTimer = setInterval(updateStats, 1000)
  updateStats()
}

async function stop() {
  clearInterval(frameTimer)
  clearInterval(statsTimer)
  clearTimeout(serialTimer)
  frameTimer = statsTimer = serialTimer = 0
  if (emulator) {
    try { await emulator.destroy() } catch { /* worker teardown continues */ }
  }
  emulator = null
  if (schedulerChannel) {
    schedulerChannel.port1.close()
    schedulerChannel.port2.close()
  }
  schedulerChannel = null
  schedulerPort = null
  sharedControl = null
}

self.onmessage = async event => {
  const message = event.data
  try {
    switch (message.type) {
      case 'start':
        await stop()
        if (message.sharedBuffer) sharedControl = new Int32Array(message.sharedBuffer)
        await start(message.config)
        break
      case 'scheduler':
        setScheduler(message.scheduler)
        break
      case 'pause':
        if (emulator) await emulator.stop()
        break
      case 'resume':
        if (emulator) await emulator.run()
        break
      case 'restart':
        if (emulator) {
          emulator.restart()
          await emulator.run()
          currentStage = 'bios'
          startedAt = performance.now()
          setStage('bios')
        }
        break
      case 'save-state': {
        if (!emulator) throw new Error('No running machine to save.')
        const buffer = await emulator.save_state()
        send({ type: 'state-saved', id: message.id, buffer }, [buffer])
        break
      }
      case 'serial':
        if (emulator) emulator.serial0_send(message.text)
        break
      case 'key':
        if (emulator) await emulator.keyboard_send_scancodes(message.codes)
        break
      case 'text':
        if (emulator) await emulator.keyboard_send_text(message.text)
        break
      case 'mouse-move':
        if (emulator) {
          emulator.bus.send('mouse-delta', [message.deltaX || 0, -(message.deltaY || 0)])
          if (message.width && message.height) {
            emulator.bus.send('mouse-absolute', [message.x || 0, message.y || 0, message.width, message.height])
          }
        }
        break
      case 'mouse-click':
        if (emulator) emulator.bus.send('mouse-click', [!!message.left, !!message.middle, !!message.right])
        break
      case 'mouse-wheel':
        if (emulator) emulator.bus.send('mouse-wheel', [message.wheel || 0, 0])
        break
      case 'stop':
        await stop()
        send({ type: 'status', status: 'idle' })
        break
    }
  } catch (error) {
    setStage('error')
    send({ type: 'error', id: message.id, error: error && error.message ? error.message : String(error) })
  }
}
