import { describe, expect, it, vi, beforeEach } from 'vitest';
import { E2BAdapter } from '../src/E2BAdapter.js';
import { CubeSandboxAdapter } from '../src/CubeSandboxAdapter.js';
import {
  E2B_PROTOCOL_CAPABILITIES,
  E2B_CLOUD_ENDPOINT,
} from '../src/types.js';
import {
  ProviderError,
  RateLimitError,
  SandboxNotFoundError,
} from '@douglas-agent/sandbank-core';

// ── helpers ────────────────────────────────────────────────────────────

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function recordingFetch(impl: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {})
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return impl(call);
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

// ── E2BAdapter ─────────────────────────────────────────────────────────

describe('E2BAdapter', () => {
  describe('contract', () => {
    it('declares 5 shared E2B capabilities', () => {
      const a = new E2BAdapter({ apiKey: 'k' });
      expect(a.capabilities).toEqual(E2B_PROTOCOL_CAPABILITIES);
      expect(Array.from(a.capabilities).sort()).toEqual([
        'exec.stream',
        'port.expose',
        'sleep',
        'snapshot',
        'terminal',
      ]);
    });

    it('has name "e2b"', () => {
      const a = new E2BAdapter({ apiKey: 'k' });
      expect(a.name).toBe('e2b');
    });

    it('throws when apiKey missing', () => {
      expect(() => new E2BAdapter({ apiKey: '' })).toThrow(ProviderError);
      expect(() => new E2BAdapter({ apiKey: undefined as unknown as string })).toThrow(ProviderError);
    });

    it('defaults apiUrl to E2B Cloud endpoint', async () => {
      const { fetch, calls } = recordingFetch(() => jsonRes({ sandboxID: 'x' }));
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      await a.createSandbox({});
      expect(calls[0]!.url).toBe(`${E2B_CLOUD_ENDPOINT}/sandboxes`);
    });

    it('overrides apiUrl when supplied (E2B Infra path)', async () => {
      const { fetch, calls } = recordingFetch(() => jsonRes({ sandboxID: 'x' }));
      const a = new E2BAdapter({
        apiKey: 'k',
        apiUrl: 'https://my-infra.example.com',
        fetch,
      });
      await a.createSandbox({});
      expect(calls[0]!.url).toBe('https://my-infra.example.com/sandboxes');
    });
  });

  describe('lifecycle', () => {
    let fetchMock: ReturnType<typeof recordingFetch>;
    let a: E2BAdapter;

    beforeEach(() => {
      fetchMock = recordingFetch(() => jsonRes({ sandboxID: 'sb-1', state: 'running', startedAt: '2026-05-20T00:00:00Z' }));
      a = new E2BAdapter({ apiKey: 'k-test', fetch: fetchMock.fetch });
    });

    it('sends POST /sandboxes with templateID + metadata + auth header', async () => {
      await a.createSandbox({ image: 'tmpl-1', env: { FOO: 'bar' } });
      const c = fetchMock.calls[0]!;
      expect(c.method).toBe('POST');
      expect(c.headers['X-API-Key']).toBe('k-test');
      expect(c.body).toEqual({
        templateID: 'tmpl-1',
        metadata: { FOO: 'bar' },
      });
    });

    it('createSandbox returns AdapterSandbox in running state', async () => {
      const sb = await a.createSandbox({});
      expect(sb.id).toBe('sb-1');
      expect(sb.state).toBe('running');
    });

    it('destroySandbox sends DELETE /sandboxes/:id', async () => {
      await a.destroySandbox('sb-1');
      expect(fetchMock.calls[0]!.method).toBe('DELETE');
      expect(fetchMock.calls[0]!.url).toContain('/sandboxes/sb-1');
    });
  });

  describe('error mapping', () => {
    it('404 → SandboxNotFoundError', async () => {
      const { fetch } = recordingFetch(() => new Response(null, { status: 404 }));
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      await expect(a.getSandbox('missing')).rejects.toBeInstanceOf(SandboxNotFoundError);
    });

    it('429 → RateLimitError with Retry-After', async () => {
      const { fetch } = recordingFetch(() =>
        new Response(null, { status: 429, headers: { 'Retry-After': '30' } })
      );
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      try {
        await a.getSandbox('x');
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitError);
        expect((e as RateLimitError).retryAfter).toBe(30);
      }
    });

    it('500 → ProviderError', async () => {
      const { fetch } = recordingFetch(() => new Response('boom', { status: 500 }));
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      await expect(a.getSandbox('x')).rejects.toBeInstanceOf(ProviderError);
    });

    it('destroySandbox is idempotent on 404', async () => {
      const { fetch } = recordingFetch(() => new Response(null, { status: 404 }));
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      await expect(a.destroySandbox('gone')).resolves.toBeUndefined();
    });
  });

  describe('listSandboxes', () => {
    it('maps to SandboxInfo and applies state filter', async () => {
      const { fetch } = recordingFetch(() =>
        jsonRes([
          { sandboxID: 'a', state: 'running', startedAt: '2026-05-20T00:00:00Z', templateID: 'base' },
          { sandboxID: 'b', state: 'killed', startedAt: '2026-05-20T00:01:00Z', templateID: 'base' },
        ])
      );
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      const list = await a.listSandboxes({ state: 'running' });
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('a');
    });

    it('respects limit', async () => {
      const { fetch } = recordingFetch(() =>
        jsonRes([
          { sandboxID: 'a', state: 'running' },
          { sandboxID: 'b', state: 'running' },
          { sandboxID: 'c', state: 'running' },
        ])
      );
      const a = new E2BAdapter({ apiKey: 'k', fetch });
      const list = await a.listSandboxes({ limit: 2 });
      expect(list).toHaveLength(2);
    });
  });

  describe('exec on AdapterSandbox', () => {
    it('POST /sandboxes/:id/exec returns ExecResult', async () => {
      const fetchCalls: FetchCall[] = [];
      const fetch = (async (url: string | URL, init?: RequestInit) => {
        const path = String(url);
        fetchCalls.push({
          url: path,
          method: init?.method ?? 'GET',
          headers: {},
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (path.endsWith('/sandboxes')) {
          return jsonRes({ sandboxID: 'sb-1', state: 'running' });
        }
        return jsonRes({ stdout: 'hi\n', stderr: '', exitCode: 0 });
      }) as unknown as typeof fetch;

      const a = new E2BAdapter({ apiKey: 'k', fetch });
      const sb = await a.createSandbox({});
      const res = await sb.exec('echo hi');
      expect(res.stdout).toBe('hi\n');
      expect(res.exitCode).toBe(0);
      const execCall = fetchCalls.find((c) => c.url.includes('/exec'))!;
      expect(execCall.method).toBe('POST');
      expect(execCall.body).toMatchObject({ command: 'echo hi' });
    });
  });
});

// ── CubeSandboxAdapter ─────────────────────────────────────────────────

describe('CubeSandboxAdapter', () => {
  describe('contract', () => {
    it('shares E2B capabilities with E2BAdapter', () => {
      const a = new CubeSandboxAdapter({ apiUrl: 'http://cube.local:3000' });
      expect(a.capabilities).toEqual(E2B_PROTOCOL_CAPABILITIES);
    });

    it('has distinct name "cube" (not "e2b")', () => {
      const a = new CubeSandboxAdapter({ apiUrl: 'http://cube.local:3000' });
      expect(a.name).toBe('cube');
    });

    it('requires apiUrl', () => {
      expect(() => new CubeSandboxAdapter({ apiUrl: '' })).toThrow(ProviderError);
    });

    it('apiKey is optional', () => {
      expect(
        () => new CubeSandboxAdapter({ apiUrl: 'http://cube.local:3000' })
      ).not.toThrow();
    });

    it('uses caller-supplied apiUrl (no default)', async () => {
      const { fetch, calls } = recordingFetch(() => jsonRes({ sandboxID: 'x' }));
      const a = new CubeSandboxAdapter({
        apiUrl: 'http://10.116.83.96:3000',
        fetch,
      });
      await a.createSandbox({});
      expect(calls[0]!.url).toBe('http://10.116.83.96:3000/sandboxes');
    });

    it('omits X-API-Key header when apiKey not provided', async () => {
      const { fetch, calls } = recordingFetch(() => jsonRes({ sandboxID: 'x' }));
      const a = new CubeSandboxAdapter({
        apiUrl: 'http://cube.local:3000',
        fetch,
      });
      await a.createSandbox({});
      expect(calls[0]!.headers['X-API-Key']).toBeUndefined();
    });
  });

  describe('shares protocol layer with E2BAdapter', () => {
    it('uses same /sandboxes endpoint path', async () => {
      const { fetch, calls } = recordingFetch(() => jsonRes({ sandboxID: 'x' }));
      const a = new CubeSandboxAdapter({
        apiUrl: 'http://cube.local:3000',
        fetch,
      });
      await a.createSandbox({});
      expect(calls[0]!.url).toMatch(/\/sandboxes$/);
    });

    it('error mapping consistent (404 → SandboxNotFoundError)', async () => {
      const { fetch } = recordingFetch(() => new Response(null, { status: 404 }));
      const a = new CubeSandboxAdapter({ apiUrl: 'http://cube.local:3000', fetch });
      await expect(a.getSandbox('x')).rejects.toBeInstanceOf(SandboxNotFoundError);
    });
  });
});
