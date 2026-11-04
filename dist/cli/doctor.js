/**
 * Live check: connection, login, then every read-only tool with no required parameters run through
 * a real MCP client. Output carries no secrets, so a report can be shared when asking for help.
 */
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../config.js';
import { buildServer, chooseTools } from '../mcp/server.js';
import { createRuntime } from '../runtime.js';
/** Read tools the doctor leaves out: they need a real file or a 2FA code, or write locally. */
const SKIP = new Set(['nas_auth_otp', 'dsm_read', 'files_read', 'files_download', 'photos_download', 'office_export', 'office_media_download', 'sheet_export']);
export async function runDoctor(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            config: { type: 'string' },
            'no-login': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const log = (line) => {
        if (!values.json)
            process.stdout.write(`${line}\n`);
    };
    const config = loadConfig({ path: values.config });
    const runtime = createRuntime(config);
    const { client, credentials, spreadsheet } = runtime;
    log(`NAS:         ${config.url}`);
    log(`Certificate: ${config.certFingerprint ? 'pinned' : config.insecureTls ? 'NOT VERIFIED (insecureTls)' : config.url.startsWith('https:') ? 'system trust store' : 'none (plain HTTP)'}`);
    let catalogSize = 0;
    try {
        const catalog = await client.catalog({ refresh: true });
        catalogSize = catalog.size;
        log(`DSM API:     reachable, ${catalog.size} APIs`);
    }
    catch (error) {
        const mapped = client.toDsmError(error);
        log(`DSM API:     FAILED: ${mapped.message}`);
        if (mapped.hint)
            log(`             ${mapped.hint}`);
        await runtime.close();
        return 1;
    }
    const selection = await chooseTools(client, config);
    log(`Tier:        ${config.tier}${config.allowPower ? ' + power' : ''}`);
    log(`Tools:       ${selection.active.length} active, ${selection.hidden.length} hidden (see "synology-mcp tools")`);
    if (values['no-login']) {
        await runtime.close();
        return 0;
    }
    const sources = await credentials.sources();
    log(`Account:     ${config.username ?? '(none)'}; password ${sources.password}; 2FA device token ${sources.deviceId}`);
    try {
        await client.login();
        log('Login:       OK');
    }
    catch (error) {
        const mapped = client.toDsmError(error);
        log(`Login:       FAILED: ${mapped.message}`);
        if (mapped.hint)
            log(`             ${mapped.hint}`);
        await runtime.close();
        return 1;
    }
    if (spreadsheet) {
        try {
            await spreadsheet.authorize();
            log(`Spreadsheet: OK, ${config.spreadsheetApiUrl}`);
        }
        catch (error) {
            const mapped = client.toDsmError(error);
            log(`Spreadsheet: FAILED: ${mapped.message}`);
            if (mapped.hint)
                log(`             ${mapped.hint}`);
        }
    }
    else {
        log('Spreadsheet: not set up (see "synology-mcp spreadsheet-setup")');
    }
    const server = buildServer({ client, config, credentials, spreadsheet }, selection);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'synology-doctor', version: '1.0.0' });
    await mcp.connect(clientSide);
    const samples = {};
    const report = [];
    const shareList = await client.tryCall('SYNO.FileStation.List', 'list_share', { limit: 1 }, { version: 2 });
    const firstShare = shareList.ok ? shareList.data.shares?.[0]?.path : undefined;
    if (firstShare) {
        samples.files_list = { path: firstShare, limit: 5 };
        samples.files_info = { paths: [firstShare] };
        samples.files_search = { folder: firstShare, pattern: '*', limit: 3, recursive: false, timeout_seconds: 15 };
        samples.storage_snapshots = { share: firstShare.slice(1) };
        samples.share_nfs_rules = { share: firstShare.slice(1) };
    }
    samples.dsm_api_search = { query: 'SYNO.Core.System', limit: 3 };
    samples.docker_registry_search = { query: 'nginx', limit: 1 };
    samples.photos_collections = { kind: 'albums', limit: 3 };
    samples.photos_search = { keyword: 'a', limit: 1 };
    const recent = await client.tryCall('SYNO.Foto.Browse.RecentlyAdded', 'list', { offset: 0, limit: 1 }, { version: 1, quoteStrings: true });
    const photo = recent.ok ? recent.data.list?.[0]?.id : undefined;
    if (photo !== undefined) {
        samples.photos_info = { id: photo };
        samples.photos_thumbnail = { id: photo, size: 'sm' };
    }
    samples.drive_search = { keyword: 'a', limit: 1 };
    samples.drive_list = { limit: 3 };
    samples.storage_volume_usage = { volume: '/volume1' };
    samples.storage_disk = { disk: 'sata1' };
    const storage = await client.tryCall('SYNO.Storage.CGI.Storage', 'load_info', {}, { version: 1 });
    if (storage.ok) {
        const disk = storage.data.disks?.[0]?.id;
        const volume = storage.data.volumes?.[0]?.vol_path;
        if (disk)
            samples.storage_disk = { disk };
        if (volume)
            samples.storage_volume_usage = { volume };
    }
    const docker = await client.tryCall('SYNO.Docker.Container', 'list', { offset: 0, limit: 1, type: 'all' }, { version: 1 });
    const container = docker.ok ? docker.data.containers?.[0]?.name : undefined;
    if (container) {
        samples.docker_container = { name: container };
        samples.docker_logs = { name: container, limit: 3 };
    }
    const office = await client.tryCall('SYNO.SynologyDrive.Files', 'search', { keyword: '.osheet', location: 'mydrive', limit: 1 }, { version: 11, quoteStrings: true });
    const sheet = office.ok ? office.data.items?.[0]?.permanent_link : undefined;
    samples.office_lookup = { kind: 'locales' };
    if (sheet) {
        for (const name of ['office_file', 'office_read_text', 'office_snapshot', 'office_versions', 'office_attachments', 'sheet_info'])
            samples[name] = { file: sheet };
        samples.sheet_read = { file: sheet, range: 'A1:C3' };
        samples.sheet_styles = { file: sheet, range: 'A1:A1' };
    }
    const readTools = selection.active.filter((t) => t.tier === 'read' && !SKIP.has(t.name));
    log(`\nTrying ${readTools.length} read tools:`);
    for (const def of readTools) {
        const needsArgs = Object.values(def.input ?? {}).some((schema) => !schema.isOptional());
        const args = samples[def.name];
        if (needsArgs && !args) {
            log(`  skip  ${def.name} (no sample to test with on this NAS)`);
            continue;
        }
        const started = Date.now();
        const result = await mcp.callTool({ name: def.name, arguments: args ?? {} }).catch((error) => ({
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: { message: error.message } }) }],
        }));
        const ms = Date.now() - started;
        const text = result.content[0]?.text ?? '';
        const parsed = result.isError ? safeJson(text) : undefined;
        report.push({ tool: def.name, ok: !result.isError, ms, error: parsed?.error });
        if (result.isError) {
            log(`  FAIL  ${def.name} (${ms} ms): ${parsed?.error?.kind ?? ''} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? text}`);
        }
        else {
            log(`  ok    ${def.name} (${ms} ms)`);
        }
    }
    const failed = report.filter((r) => !r.ok);
    log(`\n${report.length - failed.length} of ${report.length} passed.`);
    if (values.json) {
        process.stdout.write(`${JSON.stringify({ url: config.url, apis: catalogSize, tier: config.tier, report }, null, 2)}\n`);
    }
    await mcp.close();
    await runtime.close();
    return failed.length ? 1 : 0;
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
