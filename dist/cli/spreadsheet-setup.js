/**
 * Connects the synology/spreadsheet-api container: tests a login through it once, and only then
 * stores anything. Its /authorize takes no 2FA code, so a 2FA account needs a dedicated one here.
 */
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { instanceKey, loadConfig, saveFileConfig } from '../config.js';
import { CredentialProvider } from '../credentials.js';
import { SpreadsheetClient } from '../dsm/spreadsheet.js';
import { fetchPeerCertificate } from '../dsm/tls.js';
import { askHidden, readAllStdin } from './setup.js';
export async function runSpreadsheetSetup(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            config: { type: 'string' },
            url: { type: 'string' },
            'dsm-host': { type: 'string' },
            'dsm-protocol': { type: 'string' },
            username: { type: 'string' },
            'password-stdin': { type: 'boolean', default: false },
            'accept-cert': { type: 'boolean', default: false },
        },
    });
    const config = loadConfig({ path: values.config });
    const interactive = input.isTTY === true;
    const ask = async (question, fallback) => {
        if (!interactive)
            return fallback ?? '';
        const rl = createInterface({ input, output });
        try {
            const suffix = fallback ? ` [${fallback}]` : '';
            return (await rl.question(`${question}${suffix}: `)).trim() || fallback || '';
        }
        finally {
            rl.close();
        }
    };
    const nas = new URL(config.url);
    output.write('Spreadsheet API setup. The container must already be running: see docker-compose.spreadsheet.yml.\n\n');
    const url = (values.url ?? (await ask('Container address', config.spreadsheetApiUrl ?? `http://${nas.hostname}:3000`))).replace(/\/+$/, '');
    if (!url)
        throw new Error('The container address is needed.');
    output.write('\nThe container logs in to DSM by itself. Its check of DSM\'s self-signed certificate fails, so it usually needs DSM\'s plain http port.\n');
    const dsmProtocol = values['dsm-protocol'] ?? (await ask('Protocol the container uses to reach DSM (http or https)', config.spreadsheetDsmProtocol ?? 'http'));
    if (dsmProtocol !== 'http' && dsmProtocol !== 'https')
        throw new Error('The protocol must be http or https.');
    const dsmHost = values['dsm-host'] ?? (await ask('host:port the container uses to reach DSM', config.spreadsheetDsmHost ?? nas.host));
    if (!dsmHost)
        throw new Error('The DSM host is needed.');
    let certFingerprint;
    if (url.startsWith('https:')) {
        const cert = await fetchPeerCertificate(url);
        output.write(`\nThe container presents this certificate:\n  subject:  ${cert.subject}\n  expires:  ${cert.validTo}\n  sha-256:  ${cert.fingerprint256}\n`);
        if (!(values['accept-cert'] || /^y/i.test(await ask('Pin it? (y/n)', 'y'))))
            throw new Error('Certificate not accepted, so nothing was changed.');
        certFingerprint = cert.fingerprint256;
    }
    else {
        output.write('\nThis address is plain http, so the password and token are not encrypted on the way to the container. Use it only on a network you trust, such as a VPN.\n');
    }
    output.write('\nThis API accepts no 2FA code. If your DSM account uses 2FA, give a dedicated account without it.\n');
    const username = values.username ?? (await ask('Dedicated DSM account (empty to use the main one)', config.spreadsheetUsername));
    const credentials = new CredentialProvider(instanceKey(config.url), config.username);
    let password;
    if (username) {
        password = values['password-stdin'] ? await readAllStdin() : await askHidden(`Password for ${username} (hidden): `);
        if (!password)
            throw new Error('A password is needed.');
    }
    const client = new SpreadsheetClient({ url, dsmHost, dsmProtocol, certFingerprint, timeoutMs: 30_000 }, async () => (username && password ? { username, password } : credentials.resolveSpreadsheet()));
    try {
        await client.authorize();
    }
    catch (error) {
        const detail = error;
        throw new Error(`${detail.message}${detail.hint ? `\n${detail.hint}` : ''}`);
    }
    finally {
        await client.close();
    }
    // Stored only after the container accepted them, so a typo never replaces working settings.
    if (username && password)
        await credentials.saveSpreadsheetPassword(password);
    saveFileConfig(config.configPath, {
        spreadsheetApiUrl: url,
        spreadsheetDsmHost: dsmHost,
        spreadsheetDsmProtocol: dsmProtocol,
        ...(username ? { spreadsheetUsername: username } : {}),
        ...(certFingerprint ? { spreadsheetCertFingerprint: certFingerprint } : {}),
    });
    output.write(`\nConnected. Settings are in ${config.configPath}. Restart your MCP client to get the sheet_* tools.\n`);
}
