/** Lists the tools a connection exposes and what their definitions cost in a client's context. */
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../config.js';
import { buildServer, chooseTools } from '../mcp/server.js';
import { createRuntime } from '../runtime.js';
export async function runToolsReport(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { config: { type: 'string' }, hidden: { type: 'boolean', default: false } },
    });
    const config = loadConfig({ path: values.config });
    const runtime = createRuntime(config);
    const { client, credentials, spreadsheet } = runtime;
    const selection = await chooseTools(client, config);
    const server = buildServer({ client, config, credentials, spreadsheet }, selection);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'synology-tools-report', version: '1.0.0' });
    await mcp.connect(clientSide);
    const { tools } = await mcp.listTools();
    const byModule = new Map();
    for (const def of selection.active)
        byModule.set(def.module, [...(byModule.get(def.module) ?? []), `${def.name}${def.tier === 'read' ? '' : ` [${def.tier}]`}`]);
    for (const [module, names] of byModule)
        process.stdout.write(`${module} (${names.length}): ${names.join(', ')}\n`);
    const size = JSON.stringify(tools).length;
    process.stdout.write(`\n${tools.length} tools; definitions are about ${Math.round(size / 4 / 100) / 10}k tokens (${size} characters).\n`);
    if (values.hidden) {
        process.stdout.write('\nHidden:\n');
        for (const hidden of selection.hidden)
            process.stdout.write(`  ${hidden.name}: ${hidden.detail}\n`);
    }
    else if (selection.hidden.length) {
        process.stdout.write(`${selection.hidden.length} hidden (--hidden lists them).\n`);
    }
    await mcp.close();
    await runtime.close();
}
