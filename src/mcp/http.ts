/**
 * Streamable HTTP transport, for running the server on the NAS itself or another always-on host.
 * Stateless: each request gets its own transport and MCP server, sharing one DSM session.
 *
 * Anything that can reach this port can do whatever the configured tier allows, so a bearer token
 * is required on every address but loopback, and Host and Origin are checked against DNS rebinding.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigError } from '../config.js';

export interface HttpOptions {
  host: string;
  port: number;
  path: string;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function validateHttpOptions(options: HttpOptions): void {
  if (!LOOPBACK.has(options.host) && !options.token) {
    throw new ConfigError(`Refusing to listen on ${options.host} without a token. Set SYNOLOGY_MCP_TOKEN.`);
  }
  if (!LOOPBACK.has(options.host) && options.allowedHosts.length === 0) {
    throw new ConfigError(`Set SYNOLOGY_MCP_ALLOWED_HOSTS to the host names clients use to reach this server when listening on ${options.host}.`);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function hostAllowed(request: IncomingMessage, options: HttpOptions): boolean {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (options.allowedHosts.includes(host)) return true;
  return LOOPBACK.has(options.host) && LOOPBACK.has(host);
}

function originAllowed(request: IncomingMessage, options: HttpOptions): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Browsers always send Origin on these requests; native clients don't.
  return options.allowedOrigins.includes(origin);
}

function respond(res: { writeHead(code: number, headers: Record<string, string>): unknown; end(body: string): unknown }, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

export function serveHttp(buildMcp: () => { connect(transport: StreamableHTTPServerTransport): Promise<void>; close(): Promise<void> }, options: HttpOptions): Server {
  validateHttpOptions(options);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (url.pathname !== options.path) {
      respond(res, 404, 'not found');
      return;
    }
    if (!hostAllowed(req, options) || !originAllowed(req, options)) {
      respond(res, 403, 'host or origin not allowed');
      return;
    }
    if (options.token && !tokenMatches(req.headers.authorization, options.token)) {
      res.setHeader('www-authenticate', 'Bearer');
      respond(res, 401, 'unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      respond(res, 405, 'this server is stateless: POST only');
      return;
    }
    const mcp = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(`synology-mcp: HTTP request failed: ${(error as Error).message}\n`);
      if (!res.headersSent) respond(res, 500, 'internal error');
    }
  });
  server.listen(options.port, options.host, () => {
    process.stderr.write(`synology-mcp: listening on http://${options.host}:${options.port}${options.path}\n`);
  });
  return server;
}
