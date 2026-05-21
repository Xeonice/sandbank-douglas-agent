import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AIOSandboxAdapter } from '../src/AIOSandboxAdapter.js';
import { AIO_CAPABILITIES } from '../src/types.js';
import { SandboxNotFoundError } from '@douglas-agent/sandbank-core';

// ── mocks ─────────────────────────────────────────────────────────────

const createContainerMock = vi.fn();
const startMock = vi.fn();
const inspectMock = vi.fn();
const removeMock = vi.fn();
const listContainersMock = vi.fn();
const getContainerMock = vi.fn();
const getImageMock = vi.fn();
const imageInspectMock = vi.fn();
const pullMock = vi.fn();
const followProgressMock = vi.fn();

vi.mock('dockerode', () => {
  class MockDocker {
    createContainer = createContainerMock;
    listContainers = listContainersMock;
    getContainer = getContainerMock;
    getImage = getImageMock;
    pull = pullMock;
    modem = { followProgress: followProgressMock };
  }
  return { default: MockDocker };
});

vi.mock('@agent-infra/sandbox', () => ({
  SandboxClient: vi.fn(),
}));

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  createContainerMock.mockResolvedValue({
    id: 'cnt-test-1',
    start: startMock.mockResolvedValue(undefined),
  });
  getContainerMock.mockImplementation(() => ({
    inspect: inspectMock,
    remove: removeMock,
  }));
  // Default: image already cached → ensureImage no-ops
  getImageMock.mockReturnValue({ inspect: imageInspectMock.mockResolvedValue({}) });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ── tests ─────────────────────────────────────────────────────────────

describe('AIOSandboxAdapter', () => {
  describe('contract', () => {
    it('declares capabilities exec.stream + terminal + port.expose', () => {
      const a = new AIOSandboxAdapter();
      expect(a.capabilities).toEqual(AIO_CAPABILITIES);
      expect(Array.from(a.capabilities).sort()).toEqual([
        'exec.stream',
        'port.expose',
        'terminal',
      ]);
    });

    it('has name "aio"', () => {
      const a = new AIOSandboxAdapter();
      expect(a.name).toBe('aio');
    });
  });

  describe('createSandbox', () => {
    it('runs docker container without HTTP probe by default (task-runner mode)', async () => {
      const a = new AIOSandboxAdapter({
        portRange: [54321, 54321],
      });
      const sandbox = await a.createSandbox({ env: { FOO: 'bar' } });

      expect(createContainerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          Labels: { 'sandbank-aio': 'true' },
          Env: ['FOO=bar'],
          HostConfig: expect.objectContaining({
            AutoRemove: true,
            SecurityOpt: ['seccomp=unconfined'],
            PortBindings: expect.objectContaining({
              '8080/tcp': [{ HostPort: expect.any(String) }],
            }),
          }),
        })
      );
      expect(startMock).toHaveBeenCalled();
      expect(sandbox.id).toBe('cnt-test-1');
      expect(sandbox.state).toBe('running');
    });

    it('polls readinessProbe when configured (AIO Sandbox mode)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

      const a = new AIOSandboxAdapter({
        portRange: [54330, 54330],
        readinessProbe: { path: '/v1/sandbox' },
        healthTimeoutSec: 5,
      });
      await a.createSandbox({});
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/localhost:\d+\/v1\/sandbox$/),
        expect.any(Object)
      );
    });

    it('wraps custom image when CreateConfig.image provided', async () => {
      const a = new AIOSandboxAdapter({
        portRange: [54322, 54322],
      });
      await a.createSandbox({ image: 'custom/aio:dev' });
      expect(createContainerMock).toHaveBeenCalledWith(
        expect.objectContaining({ Image: 'custom/aio:dev' })
      );
    });
  });

  describe('destroySandbox', () => {
    it('calls docker remove force=true', async () => {
      removeMock.mockResolvedValue(undefined);
      const a = new AIOSandboxAdapter();
      await a.destroySandbox('cnt-x');
      expect(getContainerMock).toHaveBeenCalledWith('cnt-x');
      expect(removeMock).toHaveBeenCalledWith({ force: true });
    });

    it('is idempotent on 404', async () => {
      const err = Object.assign(new Error('not found'), { statusCode: 404 });
      removeMock.mockRejectedValue(err);
      const a = new AIOSandboxAdapter();
      await expect(a.destroySandbox('gone')).resolves.toBeUndefined();
    });
  });

  describe('getSandbox', () => {
    it('throws SandboxNotFoundError on 404', async () => {
      const err = Object.assign(new Error('not found'), { statusCode: 404 });
      inspectMock.mockRejectedValue(err);
      const a = new AIOSandboxAdapter();
      await expect(a.getSandbox('missing')).rejects.toBeInstanceOf(
        SandboxNotFoundError
      );
    });

    it('maps inspect → AdapterSandbox', async () => {
      inspectMock.mockResolvedValue({
        Id: 'cnt-1',
        Created: '2026-05-20T00:00:00Z',
        State: { Status: 'running' },
        NetworkSettings: {
          Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] },
        },
      });
      const a = new AIOSandboxAdapter();
      const sb = await a.getSandbox('cnt-1');
      expect(sb.id).toBe('cnt-1');
      expect(sb.state).toBe('running');
    });
  });

  describe('listSandboxes', () => {
    it('filters by sandbank-aio label', async () => {
      listContainersMock.mockResolvedValue([
        {
          Id: 'a',
          Image: 'ghcr.io/agent-infra/sandbox:latest',
          Created: 1747728000,
          State: 'running',
        },
      ]);
      const a = new AIOSandboxAdapter();
      const list = await a.listSandboxes();
      expect(listContainersMock).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['sandbank-aio=true'] },
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('a');
    });

    it('applies state + limit filter', async () => {
      listContainersMock.mockResolvedValue([
        { Id: 'a', Image: 'i', Created: 1, State: 'running' },
        { Id: 'b', Image: 'i', Created: 2, State: 'exited' },
        { Id: 'c', Image: 'i', Created: 3, State: 'running' },
      ]);
      const a = new AIOSandboxAdapter();
      const list = await a.listSandboxes({ state: 'running', limit: 1 });
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('a');
    });
  });
});
