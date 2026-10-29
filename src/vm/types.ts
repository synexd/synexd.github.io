export type VMMode = 'linux' | 'xp' | 'dos'
export type LinuxVariant = 'desktop' | 'console'
export type VMStatus = 'idle' | 'loading' | 'booting' | 'running' | 'paused' | 'saving' | 'error'
export type BootStage = 'idle' | 'image' | 'restore' | 'bios' | 'bootloader' | 'os' | 'ready' | 'error'
export type SchedulerProfile = 'focus' | 'balanced' | 'background' | 'battery'

export interface BootImage {
  file: File
  cached: boolean
  source: 'bundled' | 'local' | 'indexeddb'
}

export interface VMConfiguration {
  mode: VMMode
  variant: LinuxVariant
  memoryMB: number
  vgaMemoryMB: number
  assetRoot: string
  image?: File
  secondaryImage?: File
  snapshot?: ArrayBuffer
  scheduler: SchedulerProfile
}

export interface VMStats {
  instructions: number
  mips: number
  fps: number
  frames: number
  uptimeSeconds: number
  schedulerDelay: number
  frameCap: number
  memoryMB: number
}

export interface SnapshotRecord {
  key: string
  mode: VMMode
  variant: LinuxVariant
  imageName: string
  imageSize: number
  createdAt: number
  buffer: ArrayBuffer
}

export interface CacheInfo {
  images: number
  imageBytes: number
  snapshots: number
  snapshotBytes: number
}

export interface WorkerFrameLayer {
  buffer: ArrayBuffer
  width: number
  height: number
  screenX: number
  screenY: number
}

export interface WorkerToMainMessage {
  id?: number
  type: string
  text?: string
  stage?: BootStage
  progress?: number
  status?: VMStatus
  error?: string
  width?: number
  height?: number
  graphical?: boolean
  lines?: string[]
  layers?: WorkerFrameLayer[]
  stats?: VMStats
  buffer?: ArrayBuffer
  bootMs?: number
}

export interface MainToWorkerMessage {
  id?: number
  type: string
  config?: VMConfiguration
  sharedBuffer?: SharedArrayBuffer
  scheduler?: SchedulerProfile
  visible?: boolean
  codes?: number[]
  text?: string
  x?: number
  y?: number
  width?: number
  height?: number
  left?: boolean
  middle?: boolean
  right?: boolean
  deltaX?: number
  deltaY?: number
  wheel?: number
}
