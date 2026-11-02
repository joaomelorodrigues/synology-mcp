/**
 * Interactive setup: find DSM, pin its certificate, log in with password and 2FA code, store the
 * password and the long-lived trusted-device token in the Keychain, and print the client config.
 * DSM's Auto Block counts failed logins, so a refused login ends the run rather than looping.
 */
import { realpathSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { defaultConfigPath, instanceKey, loadConfig, saveFileConfig, TIERS } from '../config.js';
import { defaultStore } from '../credentials.js';
import { DsmClient } from '../dsm/client.js';
import { DsmError } from '../dsm/errors.js';
import { fetchPeerCertificate } from '../dsm/tls.js';
const MAX_OTP_ATTEMPTS = 3;
/** Common places DSM listens, tried when the given URL isn't DSM. */
const COMMON_PORTS = [
    ['https', 5001],
    ['https', 5002],
    ['https', 7001],
    ['https', 8443],
    ['http', 5000],
    ['http', 5003],
];
function askHidden(prompt) {
    return new Promise((resolve, reject) => {
        if (!input.isTTY) {
            reject(new Error('A password prompt needs a terminal. Use --password-stdin to pipe it.'));
            return;
        }
        output.write(prompt);
        let value = '';
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === '\u0003') {
                    input.setRawMode(false);
                    output.write('\n');
                    process.exit(130);
                }
                else if (char === '\r' || char === '\n') {
                    input.setRawMode(false);
                    input.pause();
                    input.off('data', onData);
                    output.write('\n');
                    resolve(value);
                    return;
                }
                else if (char === '\u007f' || char === '\b') {
                    value = value.slice(0, -1);
                }
                else {
                    value += char;
                }
            }
        };
        input.on('data', onData);
    });
}
async function readAllStdin() {
    let data = '';
    input.setEncoding('utf8');
    for await (const chunk of input)
        data += chunk;
    return data.replace(/\r?\n$/, '');
}
/** True when the URL answers as DSM's Web API. Sends no credentials. */
async function isDsm(url, fingerprint) {
    const probe = new DsmClient({ url, certFingerprint: fingerprint, insecureTls: !fingerprint && url.startsWith('https:'), timeoutMs: 6_000, deviceName: 'probe' }, { resolve: async () => undefined }, false);
    try {
        const catalog = await probe.catalog();
        return catalog.has('SYNO.API.Auth');
    }
    catch {
        return false;
    }
    finally {
        await probe.close();
    }
}
async function locateDsm(given) {
    if (await isDsm(given, undefined))
        return given;
    const parsed = new URL(given);
    output.write(`${given} is not answering as DSM. Trying the usual DSM ports on ${parsed.hostname}...\n`);
    for (const [scheme, port] of COMMON_PORTS) {
        const candidate = `${scheme}://${parsed.hostname}:${port}`;
        if (candidate !== given && (await isDsm(candidate, undefined))) {
            output.write(`Found DSM at ${candidate}\n`);
            return candidate;
        }
    }
    throw new Error(`Could not find DSM on ${parsed.hostname}. Check the network or VPN, and give the DSM port from Control Panel > Login Portal: synology-mcp setup --url https://host:port`);
}
function clientSnippet(configPath) {
    const node = realpathSync(process.execPath);
    const entry = realpathSync(process.argv[1]);
    const args = configPath === defaultConfigPath() ? [entry, 'serve'] : [entry, 'serve', '--config', configPath];
    return [
        'Claude Code:',
        `  claude mcp add --scope user synology -- ${node} ${args.join(' ')}`,
        '',
        'Claude Desktop (claude_desktop_config.json):',
        JSON.stringify({ mcpServers: { synology: { command: node, args } } }, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
    ].join('\n');
}
export async function runSetup(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            config: { type: 'string' },
            url: { type: 'string' },
            username: { type: 'string' },
            tier: { type: 'string' },
            otp: { type: 'string' },
            'password-stdin': { type: 'boolean', default: false },
            'accept-cert': { type: 'boolean', default: false },
        },
    });
    const existing = loadConfig({ path: values.config, allowMissingUrl: true });
    const interactive = input.isTTY === true;
    // A fresh readline per question: one left open would echo the hidden password's keystrokes.
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
    output.write('Synology MCP setup. Your password and 2FA code go only to the NAS and the Keychain.\n\n');
    const givenUrl = (values.url ?? (await ask('NAS address', existing.url || undefined))).replace(/\/+$/, '');
    if (!givenUrl)
        throw new Error('A NAS address is needed.');
    const url = await locateDsm(/^https?:\/\//.test(givenUrl) ? givenUrl : `https://${givenUrl}`);
    let certFingerprint;
    if (url.startsWith('https:')) {
        const cert = await fetchPeerCertificate(url);
        output.write(`\nThe NAS presents this certificate:\n  subject:  ${cert.subject}\n  issuer:   ${cert.issuer}\n  expires:  ${cert.validTo}\n  sha-256:  ${cert.fingerprint256}\n`);
        const changed = existing.certFingerprint && existing.certFingerprint !== cert.fingerprint256;
        if (changed)
            output.write('This differs from the certificate pinned before.\n');
        const accept = values['accept-cert'] || /^y/i.test(await ask('Pin it, so only this NAS is ever trusted? (y/n)', 'y'));
        if (!accept)
            throw new Error('Certificate not accepted, so nothing was changed.');
        certFingerprint = cert.fingerprint256;
    }
    else {
        output.write('\nWARNING: this is plain HTTP. Your password would cross the network unencrypted.\n');
    }
    const username = values.username ?? (await ask('DSM username', existing.username));
    if (!username)
        throw new Error('A username is needed.');
    const password = values['password-stdin'] ? await readAllStdin() : await askHidden('DSM password (hidden): ');
    if (!password)
        throw new Error('A password is needed.');
    const tierAnswer = values.tier ?? (await ask('Permission tier: read, write or admin', existing.tier === 'read' ? 'write' : existing.tier));
    if (!TIERS.includes(tierAnswer))
        throw new Error(`Tier must be one of ${TIERS.join(', ')}.`);
    const instance = instanceKey(url);
    const store = defaultStore();
    const candidate = { username, password };
    const client = new DsmClient({ url, certFingerprint, insecureTls: false, timeoutMs: 30_000, deviceName: existing.deviceName, sessionName: existing.sessionName }, { resolve: async () => candidate }, false);
    // With --otp the code goes first; otherwise DSM's answer says whether this account uses 2FA.
    let otp = values.otp;
    let deviceToken;
    try {
        const result = await client.login(otp ? { otpCode: otp, requestDeviceToken: true } : {});
        deviceToken = result.deviceToken;
    }
    catch (error) {
        const needsCode = error instanceof DsmError && (error.code === 403 || error.code === 406);
        if (!needsCode || otp)
            throw error;
        if (!interactive)
            throw new Error('This account uses 2FA: pass the current code with --otp.');
        // A mistyped code is common, but each miss counts toward Auto Block, so allow only a few.
        for (let attempt = 1;; attempt += 1) {
            otp = await ask('2FA code from your authenticator app');
            try {
                deviceToken = (await client.login({ otpCode: otp, requestDeviceToken: true })).deviceToken;
                break;
            }
            catch (otpError) {
                if (!(otpError instanceof DsmError) || (otpError.code !== 403 && otpError.code !== 404) || attempt === MAX_OTP_ATTEMPTS)
                    throw otpError;
                output.write('That code was not accepted. Wait for the next one and try again.\n');
            }
        }
    }
    // Saved only after DSM accepted them, so a typo never replaces working credentials.
    await store.set(instance, 'password', password);
    if (otp && !deviceToken) {
        output.write('\nWARNING: DSM returned no trusted-device token, so a new code will be needed on the next login.\n');
    }
    if (deviceToken && otp)
        await store.set(instance, 'device_id', deviceToken);
    if (!otp)
        await store.remove(instance, 'device_id');
    saveFileConfig(existing.configPath, {
        url,
        username,
        tier: tierAnswer,
        ...(certFingerprint ? { certFingerprint } : {}),
    });
    const info = await client.tryCall('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
    await client.close();
    output.write(`\nConnected${info.ok ? ` to ${info.data.model}, ${info.data.version_string}` : ''}.\n`);
    output.write(`Secrets are in: ${store.name}\nSettings are in: ${existing.configPath}\n`);
    output.write(`2FA: ${otp ? (deviceToken ? 'this computer is now a trusted device, so no more codes are needed.' : 'not stored') : 'not used by this account.'}\n\n`);
    output.write(`Next, connect your MCP client:\n\n${clientSnippet(existing.configPath)}\n\nTo check every read tool against the NAS: ${realpathSync(process.execPath)} ${realpathSync(process.argv[1])} doctor\n`);
}
export async function runTrustCert(argv) {
    const { values } = parseArgs({ args: argv, options: { config: { type: 'string' }, yes: { type: 'boolean', default: false } } });
    const config = loadConfig({ path: values.config });
    if (!config.url.startsWith('https:'))
        throw new Error('The NAS URL is not https, so there is no certificate to pin.');
    const cert = await fetchPeerCertificate(config.url);
    output.write(`Pinned now:   ${config.certFingerprint ?? '(none)'}\nNAS presents: ${cert.fingerprint256}\n  subject: ${cert.subject}\n  issuer:  ${cert.issuer}\n  expires: ${cert.validTo}\n`);
    if (config.certFingerprint === cert.fingerprint256) {
        output.write('Already pinned. Nothing to do.\n');
        return;
    }
    output.write('\nOnly continue if you replaced or renewed the certificate on the NAS yourself.\n');
    let accepted = values.yes;
    if (!accepted) {
        const rl = createInterface({ input, output });
        accepted = /^y/i.test(await rl.question('Pin the new certificate? (y/n): '));
        rl.close();
    }
    if (!accepted) {
        output.write('Nothing changed.\n');
        return;
    }
    saveFileConfig(config.configPath, { certFingerprint: cert.fingerprint256 });
    output.write('Pinned. Restart the MCP server to use it.\n');
}
