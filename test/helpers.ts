import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../src/config.js';
import { CredentialProvider, type SecretName, type SecretStore } from '../src/credentials.js';
import { DsmClient } from '../src/dsm/client.js';
import { buildSpreadsheetClient } from '../src/runtime.js';
import { buildServer, chooseTools } from '../src/mcp/server.js';
import type { FakeDsm } from './fake-dsm.js';

export class MemoryStore implements SecretStore {
  readonly name = 'memory';
  readonly values = new Map<string, string>();

  async get(instance: string, name: SecretName): Promise<string | undefined> {
    return this.values.get(`${instance}/${name}`);
  }

  async set(instance: string, name: SecretName, value: string): Promise<void> {
    this.values.set(`${instance}/${name}`, value);
  }

  async remove(instance: string, name: SecretName): Promise<void> {
    this.values.delete(`${instance}/${name}`);
  }
}

export function testConfig(fake: FakeDsm, overrides: Partial<Config> = {}): Config {
  return {
    url: fake.url,
    username: 'alice',
    tier: 'admin',
    allowPower: false,
    modules: 'all',
    insecureTls: false,
    timeoutMs: 5_000,
    localRoots: [],
    protectedPaths: [],
    deviceName: 'test',
    sessionName: 'webui',
    maxOutputChars: 40_000,
    configPath: '/nonexistent/config.json',
    ...overrides,
  };
}

export interface Harness {
  mcp: Client;
  client: DsmClient;
  credentials: CredentialProvider;
  store: MemoryStore;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
  toolNames(): Promise<string[]>;
  close(): Promise<void>;
}

/** Connect a real MCP client to a real server talking to the fake DSM. */
export async function connect(fake: FakeDsm, overrides: Partial<Config> = {}, secrets: { password?: string; deviceId?: string } = {}): Promise<Harness> {
  const config = testConfig(fake, overrides);
  const store = new MemoryStore();
  const instance = new URL(fake.url).host;
  await store.set(instance, 'password', secrets.password ?? fake.options.password ?? 'secret');
  if (secrets.deviceId) await store.set(instance, 'device_id', secrets.deviceId);
  const credentials = new CredentialProvider(instance, config.username, store, {});
  const client = new DsmClient(config, credentials, false);
  const selection = await chooseTools(client, config);
  const spreadsheet = buildSpreadsheetClient(config, credentials);
  const server = buildServer({ client, config, credentials, spreadsheet }, selection);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(clientSide);

  const callRaw: Harness['callRaw'] = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    return { isError: result.isError as boolean | undefined, text: (result.content as { text: string }[])[0]?.text ?? '' };
  };
  return {
    mcp,
    client,
    credentials,
    store,
    callRaw,
    call: async (name, args = {}) => {
      const { isError, text } = await callRaw(name, args);
      if (isError) throw new Error(text);
      return JSON.parse(text);
    },
    toolNames: async () => (await mcp.listTools()).tools.map((t) => t.name),
    close: async () => {
      await mcp.close();
      await spreadsheet?.close();
      await client.close();
    },
  };
}
