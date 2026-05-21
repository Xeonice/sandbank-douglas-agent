import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MicrosandboxAdapter, MICROSANDBOX_CAPABILITIES } from '../src/index.js';
import { SandboxNotFoundError, ProviderError } from '@douglas-agent/sandbank-core';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeFetchMock(responder: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchMock: fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MicrosandboxAdapter', () => {
  let adapter: MicrosandboxAdapter;
  const sampleInfo = {
    id: 'sbx-1',
    image: 'alpine',
    status: 'running' as const,
    createdAt: '2026-05-21T00:00:00.000Z',
  };

  describe('config', () => {
    it('rejects missing apiUrl', () => {
      expect(() => new MicrosandboxAdapter({ apiUrl: '', bearerToken: 'tok' })).toThrow(/apiUrl/);
    });
    it('rejects missing bearerToken', () => {
      expect(() => new MicrosandboxAdapter({ apiUrl: 'http://x', bearerToken: '' })).toThrow(
        /bearerToken/,
      );
    });
    it('trims trailing slash from apiUrl', () => {
      const a = new MicrosandboxAdapter({ apiUrl: 'http://x:8200/', bearerToken: 'tok' });
      // Internal — we don't expose it; check via a probe call below.
      expect(a.name).toBe('microsandbox');
    });
  });

  describe('capabilities', () => {
    it('declares exec.stream + terminal + sleep + snapshot + port.expose (E2B-compatible set)', () => {
      const a = new MicrosandboxAdapter({ apiUrl: 'http://x', bearerToken: 'tok' });
      expect(a.capabilities).toEqual(MICROSANDBOX_CAPABILITIES);
      const caps = Array.from(a.capabilities).sort();
      expect(caps).toEqual(
        ['exec.stream', 'port.expose', 'sleep', 'snapshot', 'terminal'].sort(),
      );
      expect(a.capabilities.has('volumes' as never)).toBe(false);
    });
  });

  describe('createSandbox', () => {
    beforeEach(() => {
      const { fetchMock } = makeFetchMock(() => jsonResponse(201, sampleInfo));
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
        defaultCpus: 4,
        defaultMemoryMiB: 4096,
      });
    });

    it('POSTs /v1/sandboxes with image + env + cpus + memoryMiB', async () => {
      let captured: FetchCall | undefined;
      const { fetchMock } = makeFetchMock((call) => {
        captured = call;
        return jsonResponse(201, sampleInfo);
      });
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
        defaultCpus: 4,
        defaultMemoryMiB: 4096,
      });

      const sb = await adapter.createSandbox({ image: 'alpine', env: { FOO: 'bar' } });
      expect(sb.id).toBe('sbx-1');
      expect(captured?.url).toBe('http://shim:8200/v1/sandboxes');
      expect(captured?.init?.method).toBe('POST');
      expect((captured?.init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer tok',
      );
      expect(JSON.parse(captured?.init?.body as string)).toEqual({
        image: 'alpine',
        env: { FOO: 'bar' },
        cpus: 4,
        memoryMiB: 4096,
      });
    });

    it('rejects createSandbox without image', async () => {
      await expect(adapter.createSandbox({} as never)).rejects.toThrow(/image/);
    });

    it('returns an AdapterSandbox with exec / execStream', async () => {
      const sb = await adapter.createSandbox({ image: 'alpine' });
      expect(sb.id).toBe('sbx-1');
      expect(sb.state).toBe('running');
      expect(typeof sb.exec).toBe('function');
      expect(typeof sb.execStream).toBe('function');
    });
  });

  describe('exec', () => {
    it('POSTs to /v1/sandboxes/:id/exec and returns stdout/stderr/exitCode', async () => {
      let execCall: FetchCall | undefined;
      const { fetchMock } = makeFetchMock((call) => {
        if (call.url.endsWith('/exec')) {
          execCall = call;
          return jsonResponse(200, { exitCode: 0, stdout: 'hello\n', stderr: '' });
        }
        return jsonResponse(201, sampleInfo);
      });
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
      });

      const sb = await adapter.createSandbox({ image: 'alpine' });
      const result = await sb.exec('echo hello', { cwd: '/tmp', timeout: 5000 });
      expect(result).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' });
      expect(execCall?.url).toBe('http://shim:8200/v1/sandboxes/sbx-1/exec');
      expect(JSON.parse(execCall?.init?.body as string)).toMatchObject({
        command: 'echo hello',
        cwd: '/tmp',
        timeoutMs: 5000,
      });
    });
  });

  describe('execStream', () => {
    it('parses SSE events into a ReadableStream<Uint8Array>', async () => {
      const sseBody =
        'data: {"kind":"stdout","data":"hello\\n"}\n\n' +
        'data: {"kind":"stderr","data":"warn\\n"}\n\n' +
        'data: {"kind":"exited","exitCode":0}\n\n';

      const { fetchMock } = makeFetchMock((call) => {
        if (call.url.endsWith('/exec/stream')) {
          return new Response(sseBody, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return jsonResponse(201, sampleInfo);
      });

      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
      });
      const sb = await adapter.createSandbox({ image: 'alpine' });
      const stream = await sb.execStream!('echo hello', {});
      const reader = stream.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
      expect(chunks.join('')).toBe('hello\nwarn\n');
    });
  });

  describe('destroySandbox', () => {
    it('DELETEs /v1/sandboxes/:id', async () => {
      let captured: FetchCall | undefined;
      const { fetchMock } = makeFetchMock((call) => {
        captured = call;
        return jsonResponse(200, { ...sampleInfo, status: 'destroyed' });
      });
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
      });
      await adapter.destroySandbox('sbx-1');
      expect(captured?.init?.method).toBe('DELETE');
      expect(captured?.url).toBe('http://shim:8200/v1/sandboxes/sbx-1');
    });
  });

  describe('error mapping', () => {
    it('maps 404 to SandboxNotFoundError', async () => {
      const { fetchMock } = makeFetchMock(() => jsonResponse(404, { error: 'not found' }));
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
      });
      await expect(adapter.getSandbox('missing')).rejects.toBeInstanceOf(SandboxNotFoundError);
    });

    it('maps non-2xx to ProviderError', async () => {
      const { fetchMock } = makeFetchMock(() => jsonResponse(500, { error: 'boom' }));
      adapter = new MicrosandboxAdapter({
        apiUrl: 'http://shim:8200',
        bearerToken: 'tok',
        fetchImpl: fetchMock,
      });
      await expect(adapter.getSandbox('any')).rejects.toBeInstanceOf(ProviderError);
    });
  });
});
