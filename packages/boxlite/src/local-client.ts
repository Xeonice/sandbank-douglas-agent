import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsBoxlite } from '@boxlite-ai/boxlite'
import type {
  BoxLiteBox,
  BoxLiteClient,
  BoxLiteCreateParams,
  BoxLiteExecRequest,
  BoxLiteLocalConfig,
  BoxLiteSnapshot,
} from './types.js'

type BoxliteRuntime = ReturnType<typeof JsBoxlite.withDefaultConfig>
type NativeBox = Awaited<ReturnType<BoxliteRuntime['create']>>
type NativeExecution = Awaited<ReturnType<NativeBox['exec']>>
type NativeBoxInfo = ReturnType<NativeBox['info']>
type NativeBoxOptions = Parameters<BoxliteRuntime['create']>[0]

function expandHomeDir(path?: string): string | undefined {
  if (!path) return undefined
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function normalizeStatus(info: NativeBoxInfo): BoxLiteBox['status'] {
  if (info.state?.running) return 'running'

  const raw = String(info.state?.status ?? '').toLowerCase()
  for (const state of ['configured', 'stopping', 'stopped', 'paused', 'running'] as const) {
    if (raw.includes(state)) return state
  }
  if (raw.includes('created')) return 'configured'
  return 'unknown'
}

function mapBoxInfo(info: NativeBoxInfo): BoxLiteBox {
  return {
    id: info.id,
    name: info.name ?? null,
    status: normalizeStatus(info),
    created_at: info.createdAt,
    image: info.image,
    cpu: info.cpus,
    memory_mb: info.memoryMib,
  }
}

function mapSnapshotInfo(info: Awaited<ReturnType<NativeBox['snapshot']['create']>>, boxId: string): BoxLiteSnapshot {
  return {
    id: info.id,
    box_id: info.boxId || boxId,
    name: info.name,
    created_at: info.createdAt,
    size_bytes: info.sizeBytes,
    container_disk_bytes: info.containerDiskBytes,
  }
}

function createBoxOptions(params: BoxLiteCreateParams): NativeBoxOptions {
  const options: NativeBoxOptions = {
    image: params.rootfs_path ? undefined : params.image,
    rootfsPath: params.rootfs_path,
    cpus: params.cpu,
    memoryMib: params.memory_mb,
    diskSizeGb: params.disk_size_gb,
    workingDir: params.working_dir,
    autoRemove: params.auto_remove ?? false,
    env: params.env
      ? Object.entries(params.env).map(([key, value]) => ({ key, value }))
      : undefined,
    ports: params.ports?.map(([hostPort, guestPort]) => ({ hostPort, guestPort })),
    network: params.network
      ? {
          mode: params.network.mode,
          ...(params.network.allow_net ? { allowNet: params.network.allow_net } : {}),
        }
      : undefined,
    secrets: params.secrets?.map(secret => ({
      name: secret.name,
      value: secret.value,
      ...(secret.target ? { placeholder: secret.target } : {}),
    })),
    entrypoint: params.entrypoint ? [params.entrypoint] : undefined,
    cmd: params.cmd,
    user: params.user,
  }

  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as NativeBoxOptions
}

async function readExecutionStream(
  streamFactory: () => Promise<Awaited<ReturnType<NativeExecution['stdout']>>>,
): Promise<string> {
  let stream: Awaited<ReturnType<NativeExecution['stdout']>>
  try {
    stream = await streamFactory()
  } catch {
    return ''
  }

  let text = ''
  while (true) {
    const chunk = await stream.next()
    if (chunk === null) break
    text += chunk
  }
  return text
}

async function collectExecution(execution: NativeExecution): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [stdout, stderr] = await Promise.all([
    readExecutionStream(() => execution.stdout()),
    readExecutionStream(() => execution.stderr()),
  ])
  const result = await execution.wait()

  return {
    stdout,
    stderr: stderr || result.errorMessage || '',
    exitCode: result.exitCode ?? 0,
  }
}

function streamExecution(executionPromise: Promise<NativeExecution>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const execution = await executionPromise
        const [stdout, stderr] = await Promise.all([
          execution.stdout().catch(() => null),
          execution.stderr().catch(() => null),
        ])

        await Promise.all([
          (async () => {
            if (!stdout) return
            while (true) {
              const chunk = await stdout.next()
              if (chunk === null) break
              controller.enqueue(encoder.encode(chunk))
            }
          })(),
          (async () => {
            if (!stderr) return
            while (true) {
              const chunk = await stderr.next()
              if (chunk === null) break
              controller.enqueue(encoder.encode(chunk))
            }
          })(),
        ])

        const result = await execution.wait()
        if (result.errorMessage) controller.enqueue(encoder.encode(result.errorMessage))
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Create a BoxLite local client backed by the official BoxLite Node.js SDK.
 */
export function createBoxLiteLocalClient(config: BoxLiteLocalConfig): BoxLiteClient {
  const homeDir = expandHomeDir(config.boxliteHome)
  const runtime = new JsBoxlite({ ...(homeDir ? { homeDir } : {}) })
  const boxes = new Map<string, NativeBox>()

  async function getNativeBox(boxId: string): Promise<NativeBox> {
    const cached = boxes.get(boxId)
    if (cached) return cached

    const fresh = await runtime.get(boxId)
    if (!fresh) throw new Error(`Box not found: ${boxId}`)
    boxes.set(boxId, fresh)
    return fresh
  }

  async function getBoxInfo(boxId: string): Promise<NativeBoxInfo> {
    const cached = boxes.get(boxId)
    if (cached) return cached.info()

    const info = await runtime.getInfo(boxId)
    if (info) return info

    const fresh = await runtime.get(boxId)
    if (!fresh) throw new Error(`Box not found: ${boxId}`)
    boxes.set(boxId, fresh)
    return fresh.info()
  }

  async function refreshBox(boxId: string): Promise<NativeBox> {
    const fresh = await runtime.get(boxId)
    if (!fresh) throw new Error(`Box not found: ${boxId}`)
    boxes.set(boxId, fresh)
    return fresh
  }

  async function startCreatedBox(box: NativeBox): Promise<NativeBox> {
    const status = normalizeStatus(box.info())
    if (status === 'running') return box

    if (status === 'configured' || status === 'stopped' || status === 'paused') {
      await box.start()
      return await refreshBox(box.id).catch(() => box)
    }

    return box
  }

  async function startNativeExecution(boxId: string, req: BoxLiteExecRequest): Promise<NativeExecution> {
    const [command, ...args] = req.cmd
    if (!command) throw new Error('BoxLite exec requires a non-empty cmd array')

    const box = await getNativeBox(boxId)
    const env = req.env ? Object.entries(req.env) : null
    return box.exec(
      command,
      args,
      env,
      req.tty ?? false,
      null,
      req.timeout_seconds ?? null,
      req.working_dir ?? null,
    )
  }

  async function exec(
    boxId: string,
    req: BoxLiteExecRequest,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return collectExecution(await startNativeExecution(boxId, req))
  }

  return {
    async createBox(params: BoxLiteCreateParams): Promise<BoxLiteBox> {
      const box = await startCreatedBox(await runtime.create(createBoxOptions(params), params.name ?? null))
      boxes.set(box.id, box)
      return mapBoxInfo(box.info())
    },

    async getBox(boxId: string): Promise<BoxLiteBox> {
      return mapBoxInfo(await getBoxInfo(boxId))
    },

    async listBoxes(status?: string, pageSize?: number): Promise<BoxLiteBox[]> {
      let boxes = (await runtime.listInfo()).map(mapBoxInfo)
      if (status) boxes = boxes.filter(box => box.status === status)
      if (pageSize) boxes = boxes.slice(0, pageSize)
      return boxes
    },

    async deleteBox(boxId: string, force?: boolean): Promise<void> {
      await runtime.remove(boxId, force ?? false)
      boxes.delete(boxId)
    },

    async startBox(boxId: string): Promise<void> {
      const box = await getNativeBox(boxId)
      await box.start()
      await refreshBox(boxId).catch(() => box)
    },

    async stopBox(boxId: string): Promise<void> {
      const box = await getNativeBox(boxId)
      await box.stop()
      await refreshBox(boxId).catch(() => box)
    },

    exec,

    async execStream(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<ReadableStream<Uint8Array>> {
      return streamExecution(startNativeExecution(boxId, req))
    },

    async uploadFiles(boxId: string, path: string, tarData: Uint8Array): Promise<void> {
      const b64 = Buffer.from(tarData).toString('base64')
      const chunkSize = 50_000
      const chunks: string[] = []
      const tmpFile = `${path.replace(/\/$/, '') || ''}/.boxlite-upload-${Date.now()}`

      for (let i = 0; i < b64.length; i += chunkSize) {
        chunks.push(b64.slice(i, i + chunkSize))
      }

      await exec(boxId, { cmd: ['mkdir', '-p', path] })
      await exec(boxId, { cmd: ['rm', '-f', tmpFile] })

      for (const chunk of chunks) {
        await exec(boxId, {
          cmd: ['bash', '-c', `printf %s ${shellQuote(chunk)} >> ${shellQuote(tmpFile)}`],
        })
      }

      await exec(boxId, {
        cmd: ['bash', '-c', `base64 -d ${shellQuote(tmpFile)} | tar xf - -C ${shellQuote(path)} && rm -f ${shellQuote(tmpFile)}`],
      })
    },

    async downloadFiles(boxId: string, path: string): Promise<ReadableStream<Uint8Array>> {
      const result = await exec(boxId, {
        cmd: ['bash', '-c', `tar cf - -C ${shellQuote(path)} . 2>/dev/null | base64`],
      })
      const data = Buffer.from(result.stdout.trim(), 'base64')
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(data))
          controller.close()
        },
      })
    },

    async createSnapshot(boxId: string, name: string): Promise<BoxLiteSnapshot> {
      const info = await getBoxInfo(boxId)
      const wasRunning = normalizeStatus(info) === 'running'
      const box = await getNativeBox(boxId)
      if (wasRunning) await box.stop()

      try {
        const fresh = await refreshBox(boxId)
        const snapshot = await fresh.snapshot.create(name)
        return mapSnapshotInfo(snapshot, boxId)
      } finally {
        if (wasRunning) {
          const fresh = await refreshBox(boxId).catch(() => box)
          await fresh.start()
          boxes.set(boxId, fresh)
        }
      }
    },

    async restoreSnapshot(boxId: string, name: string): Promise<void> {
      const info = await getBoxInfo(boxId)
      const wasRunning = normalizeStatus(info) === 'running'
      const box = await getNativeBox(boxId)
      if (wasRunning) await box.stop()

      try {
        const fresh = await refreshBox(boxId)
        await fresh.snapshot.restore(name)
      } finally {
        if (wasRunning) {
          const fresh = await refreshBox(boxId).catch(() => box)
          await fresh.start()
          boxes.set(boxId, fresh)
        }
      }
    },

    async listSnapshots(boxId: string): Promise<BoxLiteSnapshot[]> {
      const box = await getNativeBox(boxId)
      const snapshots = await box.snapshot.list()
      return snapshots.map(snapshot => mapSnapshotInfo(snapshot, boxId))
    },

    async deleteSnapshot(boxId: string, name: string): Promise<void> {
      const box = await getNativeBox(boxId)
      await box.snapshot.remove(name)
    },

    async cloneBox(boxId: string, name?: string): Promise<BoxLiteBox> {
      const box = await getNativeBox(boxId)
      const cloned = await box.cloneBox({}, name ?? null)
      boxes.set(cloned.id, cloned)
      return mapBoxInfo(cloned.info())
    },

    async getMetrics(): Promise<Record<string, unknown>> {
      return runtime.metrics() as unknown as Record<string, unknown>
    },

    async getBoxMetrics(boxId: string): Promise<Record<string, unknown>> {
      const box = await getNativeBox(boxId)
      return box.metrics() as unknown as Record<string, unknown>
    },

    async getConfig(): Promise<Record<string, unknown>> {
      return {
        mode: 'local',
        sdk: '@boxlite-ai/boxlite',
        ...(homeDir ? { homeDir } : {}),
      }
    },

    async dispose(): Promise<void> {
      boxes.clear()
      runtime.close()
    },
  }
}
