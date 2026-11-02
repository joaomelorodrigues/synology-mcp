#!/usr/bin/env node
/** Command line entry point: serve (default), setup, doctor, trust-cert, tools. */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runDoctor } from './cli/doctor.js';
import { runSetup, runTrustCert } from './cli/setup.js';
import { runToolsReport } from './cli/tools.js';
import { ConfigError, instanceKey, loadConfig } from './config.js';
import { CredentialProvider } from './credentials.js';
import { DsmClient } from './dsm/client.js';
import { serveHttp } from './mcp/http.js';
import { buildServer, chooseTools } from './mcp/server.js';
const USAGE = `synology-mcp: MCP server for a Synology NAS

  synology-mcp setup       Connect to the NAS, pin its certificate, log in with 2FA, store secrets
  synology-mcp doctor      Check the connection and try every read tool against the NAS
  synology-mcp tools       List the tools this connection would expose, with their context cost
  synology-mcp trust-cert  Pin the NAS's current certificate after replacing it
  synology-mcp serve       Run the MCP server on stdio (the default)
  synology-mcp serve --http [--host 127.0.0.1] [--port 8765]

Options: --config <path>. See README.md.`;
async function serve(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            config: { type: 'string' },
            http: { type: 'boolean', default: false },
            host: { type: 'string', default: process.env.SYNOLOGY_MCP_HOST ?? '127.0.0.1' },
            port: { type: 'string', default: process.env.SYNOLOGY_MCP_PORT ?? '8765' },
            path: { type: 'string', default: '/mcp' },
        },
    });
    const config = loadConfig({ path: values.config });
    const credentials = new CredentialProvider(instanceKey(config.url), config.username);
    const client = new DsmClient(config, credentials);
    const selection = await chooseTools(client, config);
    if (config.insecureTls)
        process.stderr.write('synology-mcp: TLS verification is OFF (insecureTls). Prefer a pinned certificate: run setup.\n');
    if (config.url.startsWith('http:'))
        process.stderr.write('synology-mcp: plain HTTP: the password crosses the network unencrypted.\n');
    let closing = false;
    const shutdown = async () => {
        if (closing)
            return;
        closing = true;
        await client.close().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    if (values.http) {
        const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        serveHttp(() => buildServer({ client, config, credentials }, selection), {
            host: values.host,
            port: Number(values.port),
            path: values.path,
            token: process.env.SYNOLOGY_MCP_TOKEN,
            allowedHosts: list(process.env.SYNOLOGY_MCP_ALLOWED_HOSTS),
            allowedOrigins: list(process.env.SYNOLOGY_MCP_ALLOWED_ORIGINS),
        });
        return;
    }
    const server = buildServer({ client, config, credentials }, selection);
    const transport = new StdioServerTransport();
    transport.onclose = () => void shutdown();
    process.stdin.on('end', () => void shutdown());
    await server.connect(transport);
}
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
        case undefined:
            await serve([]);
            break;
        case 'serve':
            await serve(rest);
            break;
        case 'setup':
            await runSetup(rest);
            break;
        case 'trust-cert':
            await runTrustCert(rest);
            break;
        case 'doctor':
            process.exitCode = await runDoctor(rest);
            break;
        case 'tools':
            await runToolsReport(rest);
            break;
        case '--help':
        case '-h':
        case 'help':
            process.stdout.write(`${USAGE}\n`);
            break;
        default:
            if (command.startsWith('--')) {
                await serve([command, ...rest]);
                break;
            }
            process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
            process.exitCode = 2;
    }
}
main().catch((error) => {
    const message = error instanceof ConfigError ? error.message : (error.stack ?? String(error));
    process.stderr.write(`synology-mcp: ${message}\n`);
    process.exit(1);
});
