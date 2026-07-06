import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const mockState = vi.hoisted(() => {
  function makeStream(chunks: string[]) {
    const queue = [...chunks]
    return {
      next: vi.fn(async () => queue.shift() ?? null),
    }
  }

  function makeExecution(overrides?: { stdout?: string[]; stderr?: string[]; exitCode?: number; errorMessage?: string }) {
    return {
      stdout: vi.fn(async () => makeStream(overrides?.stdout ?? ['stdout'])),
      stderr: vi.fn(async () => makeStream(overrides?.stderr ?? [])),
      wait: vi.fn(async () => ({
        exitCode: overrides?.exitCode ?? 0,
        errorMessage: overrides?.errorMessage,
      })),
      stdin: vi.fn(),
      id: vi.fn(),
      kill: vi.fn(),
      resizeTty: vi.fn(),
      signal: vi.fn(),
    }
  }

  function makeInfo(overrides?: Record<string, unknown>) {
    return {
      id: 'box_123',
      name: null,
      state: { status: 'running', running: true },
      createdAt: '2026-01-01T00:00:00.000Z',
      image: 'ubuntu:24.04',
      cpus: 1,
      memoryMib: 512,
      healthStatus: { state: 'Healthy', failures: 0 },
      ...overrides,
    }
  }

  function makeBox(overrides?: Record<string, unknown>) {
    const info = makeInfo(overrides)
    const box: any = {
      id: info.id,
      name: info.name,
      info: vi.fn(() => info),
      exec: vi.fn(async () => makeExecution()),
      start: vi.fn(async () => {
        info.state = { status: 'running', running: true }
      }),
      stop: vi.fn(async () => {
        info.state = { status: 'stopped', running: false }
      }),
      snapshot: {
        create: vi.fn(async (name: string) => ({
          id: `snap-${name}`,
          boxId: info.id,
          name,
          createdAt: 123,
          containerDiskBytes: 456,
          sizeBytes: 789,
        })),
        list: vi.fn(async () => [{
          id: 'snap-one',
          boxId: info.id,
          name: 'one',
          createdAt: 123,
          containerDiskBytes: 456,
          sizeBytes: 789,
        }]),
        get: vi.fn(),
        remove: vi.fn(async () => {}),
        restore: vi.fn(async () => {}),
      },
      cloneBox: vi.fn(async (_options: object, name: string | null) => makeBox({
        id: 'box_clone',
        name,
        state: { status: 'stopped', running: false },
      })),
      metrics: vi.fn(async () => ({ commandsExecutedTotal: 2 })),
    }
    return box
  }

  function makeRuntime(options?: Record<string, unknown>) {
    const runtime: any = {
      options: options ?? {},
      boxes: new Map<string, any>(),
      create: vi.fn(async (boxOptions: Record<string, unknown>, name?: string | null) => {
        const box = makeBox({
          id: 'box_new',
          name: name ?? null,
          image: boxOptions.rootfsPath ?? boxOptions.image ?? '',
          cpus: boxOptions.cpus ?? 1,
          memoryMib: boxOptions.memoryMib ?? 512,
        })
        runtime.boxes.set(box.id, box)
        return box
      }),
      get: vi.fn(async (id: string) => runtime.boxes.get(id) ?? null),
      getInfo: vi.fn(async (id: string) => runtime.boxes.get(id)?.info() ?? null),
      listInfo: vi.fn(async () => Array.from(runtime.boxes.values()).map(box => box.info())),
      remove: vi.fn(async (id: string) => {
        runtime.boxes.delete(id)
      }),
      close: vi.fn(),
      shutdown: vi.fn(),
      metrics: vi.fn(async () => ({ numRunningBoxes: runtime.boxes.size })),
      images: {},
    }
    mockState.runtimes.push(runtime)
    return runtime
  }

  const mockState = {
    runtimes: [] as any[],
    makeRuntime,
    makeBox,
    makeExecution,
  }
  return mockState
})

vi.mock('@boxlite-ai/boxlite', () => ({
  JsBoxlite: class {
    constructor(options: Record<string, unknown>) {
      return mockState.makeRuntime(options)
    }

    static withDefaultConfig() {
      return mockState.makeRuntime({})
    }
  },
}))

import { createBoxLiteLocalClient } from '../src/local-client.js'

function createClient(config?: { boxliteHome?: string; pythonPath?: string }) {
  return createBoxLiteLocalClient({ mode: 'local', ...config })
}

function latestRuntime() {
  const runtime = mockState.runtimes.at(-1)
  if (!runtime) throw new Error('No runtime created')
  return runtime
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  return text
}

describe('BoxLiteLocalClient', () => {
  beforeEach(() => {
    mockState.runtimes.length = 0
    vi.clearAllMocks()
  })

  it('creates an official Node SDK runtime with expanded boxliteHome', () => {
    createClient({ boxliteHome: '~/sandbank-boxlite', pythonPath: '/ignored/python' })

    expect(latestRuntime().options).toEqual({
      homeDir: join(homedir(), 'sandbank-boxlite'),
    })
  })

  it('creates boxes through JsBoxlite.create with mapped options', async () => {
    const client = createClient()
    const box = await client.createBox({
      rootfs_path: '/oci/rootfs',
      name: 'named-box',
      cpu: 2,
      memory_mb: 1024,
      disk_size_gb: 8,
      working_dir: '/workspace',
      env: { FOO: 'bar' },
      auto_remove: false,
      ports: [[8080, 80]],
      network: { mode: 'enabled', allow_net: ['example.com'] },
      secrets: [{ name: 'token', value: 'secret', target: 'TOKEN_PLACEHOLDER' }],
      entrypoint: '/bin/bash',
      cmd: ['-lc', 'sleep infinity'],
      user: 'sandbank',
    })

    const runtime = latestRuntime()
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      rootfsPath: '/oci/rootfs',
      cpus: 2,
      memoryMib: 1024,
      diskSizeGb: 8,
      workingDir: '/workspace',
      env: [{ key: 'FOO', value: 'bar' }],
      autoRemove: false,
      ports: [{ hostPort: 8080, guestPort: 80 }],
      network: { mode: 'enabled', allowNet: ['example.com'] },
      secrets: [{ name: 'token', value: 'secret', placeholder: 'TOKEN_PLACEHOLDER' }],
      entrypoint: ['/bin/bash'],
      cmd: ['-lc', 'sleep infinity'],
      user: 'sandbank',
    }), 'named-box')
    expect(box).toMatchObject({
      id: 'box_new',
      name: 'named-box',
      status: 'running',
      image: '/oci/rootfs',
      cpu: 2,
      memory_mb: 1024,
    })
  })

  it('gets and lists boxes using runtime info', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    runtime.boxes.set('box_running', mockState.makeBox({ id: 'box_running' }))
    runtime.boxes.set('box_stopped', mockState.makeBox({
      id: 'box_stopped',
      state: { status: 'stopped', running: false },
    }))

    await expect(client.getBox('box_stopped')).resolves.toMatchObject({
      id: 'box_stopped',
      status: 'stopped',
    })
    await expect(client.listBoxes('running', 1)).resolves.toEqual([
      expect.objectContaining({ id: 'box_running', status: 'running' }),
    ])
  })

  it('deletes boxes with force and removes them from the runtime', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    runtime.boxes.set('box_123', mockState.makeBox({ id: 'box_123' }))

    await client.deleteBox('box_123', true)

    expect(runtime.remove).toHaveBeenCalledWith('box_123', true)
    expect(runtime.boxes.has('box_123')).toBe(false)
  })

  it('starts and stops boxes via the native box handle', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const box = mockState.makeBox({ id: 'box_123' })
    runtime.boxes.set('box_123', box)

    await client.stopBox('box_123')
    await client.startBox('box_123')

    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.start).toHaveBeenCalledTimes(1)
  })

  it('executes commands with env, tty, timeout, and working directory mapped to the native API', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const execution = mockState.makeExecution({ stdout: ['hello'], stderr: ['warn'], exitCode: 7 })
    const box = mockState.makeBox({ id: 'box_123' })
    box.exec.mockResolvedValue(execution)
    runtime.boxes.set('box_123', box)

    const result = await client.exec('box_123', {
      cmd: ['bash', '-lc', 'echo hello'],
      env: { A: 'B' },
      tty: true,
      timeout_seconds: 30,
      working_dir: '/workspace',
    })

    expect(box.exec).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'echo hello'],
      [['A', 'B']],
      true,
      null,
      30,
      '/workspace',
    )
    expect(result).toEqual({ stdout: 'hello', stderr: 'warn', exitCode: 7 })
  })

  it('returns a readable stream for execStream', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const execution = mockState.makeExecution({ stdout: ['a', 'b'] })
    const box = mockState.makeBox({ id: 'box_123' })
    box.exec.mockResolvedValue(execution)
    runtime.boxes.set('box_123', box)

    const stream = await client.execStream('box_123', { cmd: ['echo', 'hello'] })

    await expect(readStream(stream)).resolves.toBe('ab')
  })

  it('uses exec-compatible tar upload and download operations', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const box = mockState.makeBox({ id: 'box_123' })
    box.exec.mockResolvedValue(mockState.makeExecution({ stdout: ['aGVsbG8='] }))
    runtime.boxes.set('box_123', box)

    await client.uploadFiles('box_123', '/app', new Uint8Array([1, 2, 3, 4]))
    const uploadScripts = box.exec.mock.calls
      .map((call: unknown[]) => call[0] === 'bash' ? (call[1] as string[])[1] : '')
      .filter(Boolean)
    expect(uploadScripts.some((script: string) => script.includes('base64 -d'))).toBe(true)
    expect(uploadScripts.some((script: string) => script.includes("tar xf - -C '/app'"))).toBe(true)

    const stream = await client.downloadFiles('box_123', '/app')
    await expect(readStream(stream)).resolves.toBe('hello')
  })

  it('stops running boxes around snapshot create and restore, then restarts them', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const box = mockState.makeBox({ id: 'box_123' })
    runtime.boxes.set('box_123', box)

    const snapshot = await client.createSnapshot('box_123', 'snap-1')
    await client.restoreSnapshot('box_123', 'snap-1')

    expect(box.stop).toHaveBeenCalledTimes(2)
    expect(box.start).toHaveBeenCalledTimes(2)
    expect(box.snapshot.create).toHaveBeenCalledWith('snap-1')
    expect(box.snapshot.restore).toHaveBeenCalledWith('snap-1')
    expect(snapshot).toEqual({
      id: 'snap-snap-1',
      box_id: 'box_123',
      name: 'snap-1',
      created_at: 123,
      size_bytes: 789,
      container_disk_bytes: 456,
    })
  })

  it('lists and removes snapshots through the native snapshot handle', async () => {
    const client = createClient()
    const runtime = latestRuntime()
    const box = mockState.makeBox({ id: 'box_123' })
    runtime.boxes.set('box_123', box)

    await expect(client.listSnapshots('box_123')).resolves.toEqual([
      expect.objectContaining({ id: 'snap-one', name: 'one' }),
    ])
    await client.deleteSnapshot('box_123', 'one')

    expect(box.snapshot.list).toHaveBeenCalledTimes(1)
    expect(box.snapshot.remove).toHaveBeenCalledWith('one')
  })

  it('clones boxes and maps metrics/config/dispose', async () => {
    const client = createClient({ boxliteHome: '/custom/home' })
    const runtime = latestRuntime()
    const box = mockState.makeBox({ id: 'box_123' })
    runtime.boxes.set('box_123', box)

    await expect(client.cloneBox('box_123', 'clone-name')).resolves.toMatchObject({
      id: 'box_clone',
      name: 'clone-name',
      status: 'stopped',
    })
    await expect(client.getMetrics?.()).resolves.toEqual({ numRunningBoxes: 1 })
    await expect(client.getBoxMetrics?.('box_123')).resolves.toEqual({ commandsExecutedTotal: 2 })
    await expect(client.getConfig?.()).resolves.toEqual({
      mode: 'local',
      sdk: '@boxlite-ai/boxlite',
      homeDir: '/custom/home',
    })

    await client.dispose?.()
    expect(runtime.close).toHaveBeenCalledTimes(1)
  })
})
