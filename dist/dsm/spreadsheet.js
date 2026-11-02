/**
 * Client for Synology's official Spreadsheet REST API, served by the synology/spreadsheet-api
 * container. This is a different server from DSM, and the only documented way to edit the cells
 * of an .osheet in place. The container logs in to DSM on the caller's behalf, so a refused login
 * is never repeated: those failures count toward Auto Block just as direct ones do.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import { DsmError } from './errors.js';
import { buildTransports } from './tls.js';
const API = 'Spreadsheet API';
/** The DSM password goes to this address, so it may travel in the clear only within this machine. */
export function assertSafeSpreadsheetUrl(url) {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:' || hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))
        return;
    throw new DsmError(`Refusing to send a DSM password to ${url} over plain HTTP.`, {
        kind: 'refused',
        hint: 'Put an HTTPS reverse proxy in front of the container (Control Panel > Login Portal > Advanced > Reverse Proxy), or reach it through an SSH tunnel at http://127.0.0.1:<port>.',
    });
}
function kindForStatus(status) {
    if (status === 400 || status === 422)
        return 'invalid_parameter';
    if (status === 401)
        return 'auth_failed';
    if (status === 403)
        return 'permission_denied';
    if (status === 404)
        return 'not_found';
    if (status === 409)
        return 'already_exists';
    if (status === 429 || status === 503)
        return 'busy';
    return 'dsm_error';
}
function serverMessage(text) {
    try {
        const body = JSON.parse(text);
        const message = body.message ?? body.error;
        return typeof message === 'string' ? message : undefined;
    }
    catch {
        return text && text.length < 300 ? text : undefined;
    }
}
export class SpreadsheetClient {
    options;
    login;
    transports;
    token;
    flight;
    refusal;
    constructor(options, login) {
        this.options = options;
        this.login = login;
        this.transports = buildTransports({ certFingerprint: options.certFingerprint });
    }
    transportError(error, label, isRead) {
        const seen = new Set();
        let current = error;
        let code;
        let timedOut = false;
        while (current && !seen.has(current)) {
            seen.add(current);
            if (current instanceof DsmError)
                return current;
            code = current.code ?? code;
            timedOut ||= current.name === 'TimeoutError';
            current = current.cause;
        }
        const unknown = isRead ? '' : ' The change may still have been applied; check before retrying.';
        return new DsmError(timedOut
            ? `The Spreadsheet API did not answer ${label} in time.${unknown}`
            : `Could not reach the Spreadsheet API at ${this.options.url} (${code ?? 'connection failed'}).${unknown}`, {
            kind: timedOut ? 'timeout' : 'unreachable',
            api: API,
            method: label,
            retryable: isRead,
            outcomeUnknown: !isRead,
            hint: 'Check that the synology/spreadsheet-api container is running and that the network or VPN path to it is up.',
        });
    }
    /** Get a token from the container. It logs in to DSM with these credentials to issue one. */
    async authorize() {
        assertSafeSpreadsheetUrl(this.options.url);
        const login = await this.login();
        if (!login) {
            throw new DsmError('No password is stored for the Spreadsheet API account.', { kind: 'auth_failed', hint: 'Run `synology-mcp spreadsheet-setup`.' });
        }
        const fingerprint = createHash('sha256').update(`${login.username}\0${login.password}`).digest('hex');
        if (this.refusal?.fingerprint === fingerprint)
            throw this.refusal.error;
        let response;
        try {
            response = await fetch(`${this.options.url}/spreadsheets/authorize`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: login.username, password: login.password, host: this.options.dsmHost, protocol: this.options.dsmProtocol }),
                dispatcher: this.transports.single,
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
        }
        catch (error) {
            throw this.transportError(error, 'authorize', true);
        }
        const text = await response.text();
        if (!response.ok) {
            const error = new DsmError(`The Spreadsheet API refused to log in to DSM (HTTP ${response.status}${serverMessage(text) ? `: ${serverMessage(text)}` : ''}). These credentials will not be sent again until they change or the server restarts.`, {
                kind: 'auth_failed',
                api: API,
                method: 'authorize',
                hint: `Check, in this order: that the account has no 2FA (this API accepts no code, so use a dedicated account); that the container can reach DSM at ${this.options.dsmProtocol}://${this.options.dsmHost}, and does not reject its self-signed certificate (use DSM's http port); that the account may use Synology Office; and that DSM Auto Block has not blocked the container.`,
            });
            this.refusal = { fingerprint, error };
            throw error;
        }
        const token = JSON.parse(text).token;
        if (!token)
            throw new DsmError('The Spreadsheet API answered without a token.', { kind: 'bad_reply', api: API, method: 'authorize' });
        this.refusal = undefined;
        this.token = token;
        return token;
    }
    ensureToken() {
        if (this.token)
            return Promise.resolve(this.token);
        this.flight ??= this.authorize().finally(() => {
            this.flight = undefined;
        });
        return this.flight;
    }
    async send(method, path, body, signal, timeoutMs) {
        const isRead = method === 'GET';
        const label = `${method} ${path.split('?')[0]}`;
        const attempt = async (token) => {
            try {
                const timeout = AbortSignal.timeout(timeoutMs);
                return await fetch(`${this.options.url}${path}`, {
                    method,
                    headers: {
                        authorization: `Bearer ${token}`,
                        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    dispatcher: isRead ? this.transports.pooled : this.transports.single,
                    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
                });
            }
            catch (error) {
                throw this.transportError(error, label, isRead);
            }
        };
        const sent = await this.ensureToken();
        let response = await attempt(sent);
        if (response.status === 401) {
            // Tokens end with their DSM session. A rejected request was not applied, so resending is safe.
            await response.body?.cancel();
            if (this.token === sent)
                this.token = undefined;
            response = await attempt(await this.ensureToken());
        }
        if (!response.ok) {
            const text = await response.text();
            const message = serverMessage(text);
            throw new DsmError(`The Spreadsheet API answered ${label} with HTTP ${response.status}${message ? `: ${message}` : ''}.`, {
                kind: kindForStatus(response.status),
                api: API,
                method: label,
                retryable: response.status === 429 || response.status === 503,
            });
        }
        return response;
    }
    async request(method, path, body, options = {}) {
        const response = await this.send(method, path, body, options.signal, options.timeoutMs ?? 60_000);
        const text = await response.text();
        if (!text)
            return {};
        try {
            return JSON.parse(text);
        }
        catch {
            throw new DsmError(`The Spreadsheet API answered ${method} ${path.split('?')[0]} with something that is not JSON.`, { kind: 'bad_reply', api: API, method });
        }
    }
    /** Stream a binary reply to a file: temp file first, renamed only once complete. */
    async downloadToFile(path, destination, options = {}) {
        const response = await this.send('GET', path, undefined, options.signal, options.timeoutMs ?? 600_000);
        const temp = `${destination}.${randomBytes(4).toString('hex')}.part`;
        try {
            await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            const { size } = statSync(temp);
            renameSync(temp, destination);
            return size;
        }
        catch (error) {
            rmSync(temp, { force: true });
            throw this.transportError(error, `GET ${path.split('?')[0]}`, true);
        }
    }
    /** End the DSM session behind the token. Best effort at shutdown. */
    async close() {
        if (this.token) {
            await fetch(`${this.options.url}/spreadsheets/authorize/token/revoke`, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.token}` },
                dispatcher: this.transports.single,
                signal: AbortSignal.timeout(5_000),
            })
                .then((r) => r.text())
                .catch(() => undefined);
            this.token = undefined;
        }
        await Promise.allSettled([this.transports.pooled.close(), this.transports.single.close()]);
    }
}
