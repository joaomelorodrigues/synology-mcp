/**
 * A small stand-in for DSM, over real HTTP, so tests exercise the client's actual wire format:
 * form POST bodies, the session cookie, the CSRF header, multipart uploads and binary replies.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class DsmFailure extends Error {
  constructor(readonly code: number, readonly errors?: unknown) {
    super(`DSM ${code}`);
  }
}

export interface RecordedCall {
  api: string;
  method: string;
  version: number;
  params: Record<string, string>;
  url: string;
  cookie?: string;
  token?: string;
  file?: { name: string; content: string };
}

export type Route = (params: Record<string, string>, call: RecordedCall) => unknown;

export interface FakeOptions {
  username?: string;
  password?: string;
  /** When set, login needs this code or a known device token. */
  otp?: string;
  deviceToken?: string;
  catalog?: Record<string, { minVersion: number; maxVersion: number; path?: string; requestFormat?: string }>;
  tls?: { key: string; cert: string };
}

const BASE_CATALOG: NonNullable<FakeOptions['catalog']> = {
  'SYNO.API.Info': { minVersion: 1, maxVersion: 1, path: 'query.cgi' },
  'SYNO.API.Auth': { minVersion: 1, maxVersion: 7 },
};

function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; file?: { name: string; content: string } } {
  const fields: Record<string, string> = {};
  let file: { name: string; content: string } | undefined;
  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const match = /^\r\nContent-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([\s\S]*)\r\n$/i.exec(part);
    if (!match) continue;
    if (match[2] !== undefined) file = { name: match[2], content: Buffer.from(match[3]!, 'latin1').toString('utf8') };
    else fields[match[1]!] = Buffer.from(match[3]!, 'latin1').toString('utf8');
  }
  return { fields, file };
}

export class FakeDsm {
  readonly calls: RecordedCall[] = [];
  readonly logins: Record<string, string>[] = [];
  readonly routes = new Map<string, Route>();
  /** Raw replies, for streams and binary data: return true when handled. */
  readonly rawRoutes = new Map<string, (res: ServerResponse, call: RecordedCall) => void>();
  sessions = new Set<string>();
  /** Answer the first catalog request with this instead, e.g. an HTML page. */
  catalogBody: string | undefined;
  url = '';
  private server!: Server;
  private nextSession = 1;
  readonly catalog: NonNullable<FakeOptions['catalog']>;
  readonly deviceToken: string;

  constructor(readonly options: FakeOptions = {}) {
    this.catalog = { ...BASE_CATALOG, ...options.catalog };
    this.deviceToken = options.deviceToken ?? 'device-token-1';
  }

  on(api: string, method: string, route: Route): this {
    this.routes.set(`${api}/${method}`, route);
    if (!this.catalog[api]) this.catalog[api] = { minVersion: 1, maxVersion: 9, requestFormat: 'JSON' };
    return this;
  }

  onRaw(api: string, method: string, handler: (res: ServerResponse, call: RecordedCall) => void): this {
    this.rawRoutes.set(`${api}/${method}`, handler);
    if (!this.catalog[api]) this.catalog[api] = { minVersion: 1, maxVersion: 9, requestFormat: 'JSON' };
    return this;
  }

  callsTo(api: string, method?: string): RecordedCall[] {
    return this.calls.filter((c) => c.api === api && (!method || c.method === method));
  }

  expireSessions(): void {
    this.sessions.clear();
  }

  async start(): Promise<this> {
    const handler = (req: IncomingMessage, res: ServerResponse): void => void this.handle(req, res);
    this.server = this.options.tls ? createHttps(this.options.tls, handler) : createHttp(handler);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `${this.options.tls ? 'https' : 'http'}://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/webapi/query.cgi') {
      if (this.catalogBody !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(this.catalogBody);
        return;
      }
      const data = Object.fromEntries(
        Object.entries(this.catalog).map(([name, entry]) => [name, { path: 'entry.cgi', requestFormat: 'JSON', ...entry }]),
      );
      send({ success: true, data });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const type = req.headers['content-type'] ?? '';
    let params: Record<string, string> = Object.fromEntries(url.searchParams);
    let file: RecordedCall['file'];
    if (type.startsWith('multipart/form-data')) {
      const parsed = parseMultipart(body, type.split('boundary=')[1]!);
      params = { ...params, ...parsed.fields };
      file = parsed.file;
    } else if (body.length) {
      params = { ...params, ...Object.fromEntries(new URLSearchParams(body.toString())) };
    }

    const { api = '', method = '', version = '0', ...rest } = params;
    const cookie = /(?:^|;\s*)id=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const token = req.headers['x-syno-token'] as string | undefined;

    if (api === 'SYNO.API.Auth') {
      if (method === 'login') {
        this.logins.push(params);
        this.login(params, send);
      } else {
        if (cookie) this.sessions.delete(cookie);
        send({ success: true });
      }
      return;
    }

    const call: RecordedCall = { api, method, version: Number(version), params: rest, url: req.url ?? '', cookie, token, file };
    this.calls.push(call);

    if (!cookie || !this.sessions.has(cookie)) {
      send({ success: false, error: { code: 119 } });
      return;
    }
    const raw = this.rawRoutes.get(`${api}/${method}`);
    if (raw) {
      raw(res, call);
      return;
    }
    const route = this.routes.get(`${api}/${method}`);
    if (!route) {
      send({ success: false, error: { code: 103 } });
      return;
    }
    try {
      send({ success: true, data: route(rest, call) ?? {} });
    } catch (error) {
      if (error instanceof DsmFailure) send({ success: false, error: { code: error.code, errors: error.errors } });
      else throw error;
    }
  }

  private login(params: Record<string, string>, send: (body: unknown) => void): void {
    const { username = 'alice', password = 'secret', otp } = this.options;
    if (params.account !== username || params.passwd !== password) {
      send({ success: false, error: { code: 400 } });
      return;
    }
    let did: string | undefined;
    if (otp) {
      if (params.otp_code) {
        if (params.otp_code !== otp) {
          send({ success: false, error: { code: 404 } });
          return;
        }
        if (params.enable_device_token === 'yes') did = this.deviceToken;
      } else if (params.device_id !== this.deviceToken) {
        send({ success: false, error: { code: 403 } });
        return;
      }
    }
    const sid = `sid-${this.nextSession++}`;
    this.sessions.add(sid);
    send({ success: true, data: { sid, synotoken: `token-${sid}`, did } });
  }
}

/** A self-signed certificate like DSM's own, with its SHA-256 fingerprint. */
export function selfSignedCert(): { key: string; cert: string; fingerprint: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dsm-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=synology', '-addext', 'subjectAltName=DNS:synology'],
      { stdio: 'ignore' },
    );
    const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256']).toString();
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), fingerprint: out.split('=')[1]!.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
