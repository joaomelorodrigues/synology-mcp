/** Wires the clients a running server, or a CLI command that acts like one, needs. */
import { instanceKey } from './config.js';
import { CredentialProvider } from './credentials.js';
import { DsmClient } from './dsm/client.js';
import { SpreadsheetClient } from './dsm/spreadsheet.js';
export function buildSpreadsheetClient(config, credentials) {
    if (!config.spreadsheetApiUrl)
        return undefined;
    const nas = new URL(config.url);
    return new SpreadsheetClient({
        url: config.spreadsheetApiUrl,
        dsmHost: config.spreadsheetDsmHost ?? nas.host,
        dsmProtocol: config.spreadsheetDsmProtocol ?? (nas.protocol === 'https:' ? 'https' : 'http'),
        certFingerprint: config.spreadsheetCertFingerprint,
        timeoutMs: config.timeoutMs,
    }, () => credentials.resolveSpreadsheet(config.spreadsheetUsername));
}
export function createRuntime(config) {
    const credentials = new CredentialProvider(instanceKey(config.url), config.username);
    const client = new DsmClient(config, credentials);
    const spreadsheet = buildSpreadsheetClient(config, credentials);
    return {
        config,
        credentials,
        client,
        spreadsheet,
        close: async () => {
            await spreadsheet?.close().catch(() => undefined);
            await client.close();
        },
    };
}
