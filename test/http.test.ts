import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialProvider } from '../src/credentials.js';
import { DsmClient } from '../src/dsm/client.js';
import { serveHttp, validateHttpOptions, type HttpOptions } from '../src/mcp/http.js';
import { buildServer, chooseTools } from '../src/mcp/server.js';
import { FakeDsm } from './fake-dsm.js';
import { MemoryStore, testConfig } from './helpers.js';

const TOKEN = 'a-long-random-token-for-tests';

describe('HTTP transport', () => {
  let fake: FakeDsm;
  let server: Server | undefined;
  let client: DsmClient;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    await client?.close();
    await fake?.stop();
    server = undefined;
  });

  async function start(options: Partial<HttpOptions> = {}): Promise<string> {
    fake = await new FakeDsm().on('SYNO.DSM.Info', 'getinfo', () => ({ model: 'DS923+' })).start();
    const config = testConfig(fake, { tier: 'read' });
    const store = new MemoryStore();
    await store.set(new URL(fake.url).host, 'password', 'secret');
    const credentials = new CredentialProvider(new URL(fake.url).host, 'alice', store, {});
    client = new DsmClient(config, credentials, false);
    const selection = await chooseTools(client, config);
    server = serveHttp(() => buildServer({ client, config, credentials }, selection), {
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      token: TOKEN,
      allowedHosts: [],
      allowedOrigins: [],
      ...options,
    });
    await new Promise((resolve) => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(initialize),
    });

  it('serves MCP to a client presenting the token', async () => {
    const url = await start();
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
    const mcp = new Client({ name: 't', version: '1' });
    await mcp.connect(transport);
    const result = await mcp.callTool({ name: 'system_info', arguments: {} });
    expect((result.content as { text: string }[])[0]!.text).toContain('DS923+');
    await mcp.close();
    // One session on the NAS, however many HTTP requests came in.
    expect(fake.logins).toHaveLength(1);
  });

  it('refuses a missing or wrong token', async () => {
    const url = await start();
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(url, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('refuses browser origins, against DNS rebinding', async () => {
    const url = await start();
    const response = await post(url, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('allows an origin that is configured', async () => {
    const url = await start({ allowedOrigins: ['https://mine.example'] });
    const response = await post(url, { authorization: `Bearer ${TOKEN}`, origin: 'https://mine.example' });
    expect(response.status).toBe(200);
  });

  it('answers health checks without authentication, and nothing else', async () => {
    const url = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  it('will not listen beyond loopback without a token and host list', () => {
    const base = { port: 1, path: '/mcp', allowedOrigins: [] };
    expect(() => validateHttpOptions({ ...base, host: '0.0.0.0', allowedHosts: ['nas'] })).toThrow(/token/);
    expect(() => validateHttpOptions({ ...base, host: '0.0.0.0', token: 't', allowedHosts: [] })).toThrow(/ALLOWED_HOSTS/);
    expect(() => validateHttpOptions({ ...base, host: '0.0.0.0', token: 't', allowedHosts: ['nas'] })).not.toThrow();
    expect(() => validateHttpOptions({ ...base, host: '127.0.0.1', allowedHosts: [] })).not.toThrow();
  });
});
