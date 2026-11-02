/** Runs the built program as a real process, as an MCP client would. Needs `npm run build`. */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDsm } from './fake-dsm.js';

const ENTRY = resolve('dist/index.js');

function run(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

describe.skipIf(!existsSync(ENTRY))('the built program', () => {
  let fake: FakeDsm;
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    fake = await new FakeDsm({ otp: '123456' })
      .on('SYNO.DSM.Info', 'getinfo', () => ({ model: 'DS923+', version_string: 'DSM 7.2.2-72806', uptime: 100 }))
      .on('SYNO.FileStation.List', 'list_share', () => ({ total: 1, shares: [{ path: '/docker' }] }))
      .start();
    dir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
    env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, SYNOLOGY_SECRET_STORE: 'file', HOME: dir };
  });

  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setUp(): Promise<void> {
    const result = await run(['setup', '--url', fake.url, '--username', 'alice', '--tier', 'write', '--otp', '123456', '--password-stdin'], env, 'secret\n');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }

  it('sets up a 2FA account: secrets in the store with owner-only access, none in the config', async () => {
    await setUp();
    const config = readFileSync(join(dir, 'synology-mcp/config.json'), 'utf8');
    expect(JSON.parse(config)).toMatchObject({ url: fake.url, username: 'alice', tier: 'write' });
    expect(config).not.toContain('secret');
    expect(config).not.toContain('device-token');
    const stored = join(dir, 'synology-mcp/credentials.json');
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(stored, 'utf8'))[new URL(fake.url).host]).toEqual({ password: 'secret', device_id: 'device-token-1' });
  });

  it('stores nothing when the login is refused', async () => {
    const result = await run(['setup', '--url', fake.url, '--username', 'alice', '--tier', 'write', '--otp', '000000', '--password-stdin'], env, 'secret\n');
    expect(result.code).toBe(1);
    expect(existsSync(join(dir, 'synology-mcp/credentials.json'))).toBe(false);
    expect(existsSync(join(dir, 'synology-mcp/config.json'))).toBe(false);
    expect(fake.logins).toHaveLength(1);
  });

  it('never prints the password', async () => {
    const result = await run(['setup', '--url', fake.url, '--username', 'alice', '--tier', 'write', '--otp', '123456', '--password-stdin'], env, 'secret\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret');
    expect(`${result.stdout}${result.stderr}`).not.toContain('device-token');
  });

  it('then serves MCP over stdio, logging in with the stored device token', async () => {
    await setUp();
    fake.logins.length = 0;
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'serve'], env, stderr: 'pipe' });
    const mcp = new Client({ name: 'e2e', version: '1.0.0' });
    await mcp.connect(transport);
    try {
      expect(mcp.getInstructions()).toContain('nas_overview');
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toContain('files_shares');
      expect(tools.map((t) => t.name)).not.toContain('docker_containers');
      const result = await mcp.callTool({ name: 'system_info', arguments: {} });
      expect((result.content as { text: string }[])[0]!.text).toContain('DS923+');
      expect(fake.logins[0]!.device_id).toBe('device-token-1');
      expect(fake.logins[0]!.otp_code).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });

  it('logs out of DSM when the client disconnects', async () => {
    await setUp();
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'serve'], env, stderr: 'pipe' });
    const mcp = new Client({ name: 'e2e', version: '1.0.0' });
    await mcp.connect(transport);
    await mcp.callTool({ name: 'system_info', arguments: {} });
    const before = fake.sessions.size;
    await mcp.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sessions.size).toBe(before - 1);
  });

  it('checks a working setup with doctor, sharing no secrets', async () => {
    await setUp();
    const result = await run(['doctor'], env);
    expect(result.stdout).toContain('Login:       OK');
    expect(result.stdout).not.toContain('secret');
    expect(result.stdout).not.toContain('device-token');
  });

  it('will not set up the Spreadsheet API over plain HTTP to another machine', async () => {
    await setUp();
    const before = readFileSync(join(dir, 'synology-mcp/config.json'), 'utf8');
    const result = await run(['spreadsheet-setup', '--url', 'http://192.0.2.1:3000', '--dsm-protocol', 'http', '--dsm-host', 'dsm:5003', '--username', 'bob', '--password-stdin'], env, 'hunter2\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('plain HTTP');
    expect(`${result.stdout}${result.stderr}`).not.toContain('hunter2');
    expect(readFileSync(join(dir, 'synology-mcp/config.json'), 'utf8')).toBe(before);
  });

  it('refuses to run with no NAS configured, saying what to do', async () => {
    const result = await run(['serve'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('synology-mcp setup');
  });
});
