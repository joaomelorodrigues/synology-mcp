/**
 * DSM Web API client. It knows DSM's conventions and nothing about individual APIs:
 *
 * - API discovery through SYNO.API.Info, which needs no login, with versions clamped to what
 *   the NAS offers.
 * - Form POST for every JSON call, so secrets and free text stay out of access logs.
 * - The session travels as the `id` cookie, never `_sid`: DSM parses `_sid` as JSON and some
 *   session IDs are misread that way, giving spurious 119 errors.
 * - X-SYNO-TOKEN on every call, since DSM 7.3.2+ enforces CSRF on mutating endpoints.
 * - One login at a time, one transparent re-login on session errors, and never a second try of
 *   credentials DSM refused: repeated failures trip Auto Block, which would lock this computer's
 *   IP out of the NAS entirely.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch, FormData, type Response } from 'undici';
import { instanceKey, stateDir, type Config } from '../config.js';
import type { CredentialProvider, Credentials } from '../credentials.js';
import { DsmError, errorFromCode, SESSION_CODES } from './errors.js';
import { buildTransports, type Transports } from './tls.js';

export interface ApiEntry {
  path: string;
  minVersion: number;
  maxVersion: number;
  requestFormat?: string;
}

export type Catalog = Map<string, ApiEntry>;

/** JSON-quote a free-text value. DSM reads `2024` or `true` unquoted as a number or boolean. */
export function q(value: string): string {
  return JSON.stringify(value);
}

export type ParamValue = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;
export type Params = Record<string, ParamValue>;

export function encodeParams(params: Params, options: { quoteStrings?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[key] = options.quoteStrings ? JSON.stringify(value) : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else out[key] = JSON.stringify(value);
  }
  return out;
}

export interface CallOptions {
  /** Exact version to request; clamped to the NAS's range unless `exactVersion`. */
  version?: number;
  /** Fail instead of clamping when the NAS does not offer `version`. */
  exactVersion?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override read detection. Writes use a fresh connection and are never resent. */
  write?: boolean;
  /** JSON-quote all string parameters, as DSM's own web client does. */
  quoteStrings?: boolean;
  /** For binary replies: send parameters in a POST body, not the URL, e.g. a document password. */
  post?: boolean;
}

const READ_METHOD = /^(get|list|count|load|query|status|info|check|search|enum|is_|potential)/i;

export function isReadMethod(method: string): boolean {
  return READ_METHOD.test(method);
}

export interface LoginOptions {
  otpCode?: string;
  /** Ask DSM for a long-lived trusted-device token, used with otpCode. */
  requestDeviceToken?: boolean;
}

export interface LoginResult {
  deviceToken?: string;
}

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

export class DsmClient {
  private readonly transports: Transports;
  private catalogCache: Catalog | undefined;
  private catalogLoad: Promise<Catalog> | undefined;
  private sid: string | undefined;
  private synoToken: string | undefined;
  private loginFlight: Promise<void> | undefined;
  private refusal: { fingerprint: string; error: DsmError } | undefined;
  private readonly sessionName: string;
  /**
   * DSM ends the session the cookie belongs to, whatever name a logout carries. This one matches
   * nothing, so that it can never be read as "every webui session", which would include the
   * user's own browser on the same account.
   */
  private readonly logoutName = `SynologyMCP_${randomBytes(4).toString('hex')}`;

  constructor(
    readonly config: Pick<Config, 'url' | 'certFingerprint' | 'insecureTls' | 'timeoutMs' | 'deviceName'> & { sessionName?: string },
    private readonly credentials: Pick<CredentialProvider, 'resolve'>,
    private readonly stateRoot: string | false = stateDir(),
  ) {
    this.transports = buildTransports(config);
    this.sessionName = config.sessionName ?? 'webui';
  }

  get loggedIn(): boolean {
    return this.sid !== undefined;
  }

  // ---------------------------------------------------------------- discovery

  private catalogFile(): string | undefined {
    if (!this.stateRoot) return undefined;
    return join(this.stateRoot, `catalog-${instanceKey(this.config.url).replace(/[^\w.-]/g, '_')}.json`);
  }

  /** The NAS's API list. Falls back to the last saved copy when the NAS is unreachable. */
  async catalog(options: { refresh?: boolean; timeoutMs?: number } = {}): Promise<Catalog> {
    if (this.catalogCache && !options.refresh) return this.catalogCache;
    this.catalogLoad ??= this.loadCatalog(options.timeoutMs).finally(() => {
      this.catalogLoad = undefined;
    });
    return this.catalogLoad;
  }

  private async loadCatalog(timeoutMs?: number): Promise<Catalog> {
    const url = `${this.config.url}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=ALL`;
    let response: Response;
    try {
      response = await fetch(url, {
        dispatcher: this.transports.pooled,
        signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs),
      });
    } catch (error) {
      const mapped = this.mapTransportError(error, 'SYNO.API.Info', 'query', true);
      if (mapped.kind === 'tls_pin_mismatch') throw mapped;
      const saved = this.readSavedCatalog();
      if (saved) {
        this.catalogCache = saved;
        return saved;
      }
      throw mapped;
    }
    const text = await response.text();
    let body: { success?: boolean; data?: Record<string, ApiEntry> } | undefined;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      /* handled below */
    }
    if (!response.ok || !body?.success || !body.data) {
      throw new DsmError(`${this.config.url} answered, but not as DSM's Web API (HTTP ${response.status}).`, {
        kind: 'bad_reply',
        api: 'SYNO.API.Info',
        method: 'query',
        hint: 'The URL must include the DSM port (Control Panel > Login Portal > DSM). Ports 80 and 443 often serve Web Station instead.',
      });
    }
    const catalog: Catalog = new Map(Object.entries(body.data));
    this.catalogCache = catalog;
    this.saveCatalog(body.data);
    return catalog;
  }

  private saveCatalog(data: Record<string, ApiEntry>): void {
    const file = this.catalogFile();
    if (!file) return;
    try {
      mkdirSync(this.stateRoot as string, { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // The saved copy only helps while offline; failing to write it changes nothing else.
    }
  }

  private readSavedCatalog(): Catalog | undefined {
    const file = this.catalogFile();
    if (!file || !existsSync(file)) return undefined;
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, ApiEntry>));
    } catch {
      return undefined;
    }
  }

  /** Whether the NAS offers an API. Unknown (no catalog at all) counts as yes: the call will say. */
  has(api: string): boolean {
    return this.catalogCache ? this.catalogCache.has(api) : true;
  }

  private async entry(api: string, method: string): Promise<ApiEntry> {
    const catalog = await this.catalog();
    const entry = catalog.get(api);
    if (!entry) {
      throw new DsmError(`${api} is not available on this NAS.`, {
        kind: 'api_not_found',
        code: 102,
        api,
        method,
        hint: 'The package providing it is probably not installed or not running. Check packages_list, or dsm_api_search for similar APIs.',
      });
    }
    return entry;
  }

  private negotiate(entry: ApiEntry, api: string, method: string, options: CallOptions): number {
    if (options.version === undefined) return entry.maxVersion;
    if (options.exactVersion && (options.version < entry.minVersion || options.version > entry.maxVersion)) {
      throw new DsmError(
        `${api} v${options.version} is not offered by this NAS (it has v${entry.minVersion}-${entry.maxVersion}).`,
        { kind: 'not_supported', code: 104, api, method },
      );
    }
    return Math.min(Math.max(options.version, entry.minVersion), entry.maxVersion);
  }

  // ---------------------------------------------------------------- session

  private headers(): Record<string, string> {
    return {
      ...(this.sid ? { cookie: `id=${this.sid}` } : {}),
      ...(this.synoToken ? { 'x-syno-token': this.synoToken } : {}),
    };
  }

  private fingerprint(credentials: Credentials): string {
    return createHash('sha256')
      .update([credentials.username, credentials.password, credentials.deviceId ?? ''].join('\0'))
      .digest('hex');
  }

  /** Log in. With otpCode this is the 2FA bootstrap; the caller stores the returned token. */
  async login(options: LoginOptions = {}): Promise<LoginResult> {
    const credentials = await this.credentials.resolve();
    if (!credentials) {
      throw new DsmError('No DSM credentials are stored for this NAS.', {
        kind: 'auth_failed',
        hint: 'Run `synology-mcp setup` in a terminal.',
      });
    }
    const fingerprint = this.fingerprint(credentials);
    if (!options.otpCode && this.refusal?.fingerprint === fingerprint) throw this.refusal.error;

    const entry = await this.entry('SYNO.API.Auth', 'login');
    const version = Math.min(6, entry.maxVersion);
    const form = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: String(version),
      method: 'login',
      account: credentials.username,
      passwd: credentials.password,
      session: this.sessionName,
      format: 'sid',
      enable_syno_token: 'yes',
      device_name: this.config.deviceName,
    });
    if (options.otpCode) form.set('otp_code', options.otpCode);
    if (options.requestDeviceToken) form.set('enable_device_token', 'yes');
    if (!options.otpCode && credentials.deviceId) form.set('device_id', credentials.deviceId);

    let body: { success?: boolean; data?: { sid?: string; synotoken?: string; did?: string }; error?: { code?: number } };
    try {
      const response = await fetch(`${this.config.url}/webapi/${entry.path}`, {
        method: 'POST',
        body: form,
        dispatcher: this.transports.single,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      body = this.parseJson(await response.text(), response.status, 'SYNO.API.Auth', 'login') as typeof body;
    } catch (error) {
      throw error instanceof DsmError ? error : this.mapTransportError(error, 'SYNO.API.Auth', 'login', false);
    }

    if (!body.success || !body.data?.sid) {
      const refused = this.refusalError(body.error?.code ?? 0, credentials, options);
      // An OTP attempt says nothing lasting about the stored credentials, so it isn't remembered.
      if (!options.otpCode) this.refusal = { fingerprint, error: refused };
      throw refused;
    }

    this.refusal = undefined;
    this.sid = body.data.sid;
    this.synoToken = body.data.synotoken;
    return { deviceToken: body.data.did };
  }

  private refusalError(code: number, credentials: Credentials, options: LoginOptions): DsmError {
    const base = errorFromCode('SYNO.API.Auth', 'login', code);
    let hint: string;
    if (options.otpCode && (code === 403 || code === 404)) {
      hint = 'The code was wrong or expired. Wait for the next 30-second code and try again.';
    } else if (code === 403 || code === 404 || code === 406) {
      hint = credentials.deviceId
        ? 'DSM no longer accepts the stored trusted-device token (it may have been removed in Personal > Security > Sign-in Activity). Call nas_auth_otp with a fresh 2FA code, or run `synology-mcp setup`.'
        : 'This account uses 2FA and no trusted-device token is stored. Call nas_auth_otp with a current 2FA code, or run `synology-mcp setup`.';
    } else if (code === 402) {
      hint = `DSM does not let this account log in with session name "${this.sessionName}". Check its access to DSM in Control Panel > Application Privileges, or set sessionName in the config.`;
    } else if (code === 407) {
      hint = base.hint ?? '';
    } else {
      hint = 'Run `synology-mcp setup` to store the right credentials.';
    }
    const guard = options.otpCode
      ? ''
      : ' These credentials will not be sent again until they change or the server restarts, because repeated failures trip DSM Auto Block.';
    return new DsmError(`DSM refused the login: ${base.message}.${guard}`, {
      kind: base.kind,
      code,
      api: 'SYNO.API.Auth',
      method: 'login',
      hint,
    });
  }

  private async ensureSession(): Promise<void> {
    if (this.sid) return;
    await this.sharedLogin();
  }

  private sharedLogin(): Promise<void> {
    this.loginFlight ??= this.login()
      .then(() => undefined)
      .finally(() => {
        this.loginFlight = undefined;
      });
    return this.loginFlight;
  }

  /** Replace an expired session, unless another request already replaced it. */
  private async relogin(failedSid: string | undefined): Promise<void> {
    if (this.sid !== failedSid) return;
    await this.sharedLogin();
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      const entry = await this.entry('SYNO.API.Auth', 'logout');
      await fetch(`${this.config.url}/webapi/${entry.path}`, {
        method: 'POST',
        headers: this.headers(),
        body: new URLSearchParams({
          api: 'SYNO.API.Auth',
          version: String(Math.min(6, entry.maxVersion)),
          method: 'logout',
          session: this.logoutName,
        }),
        dispatcher: this.transports.single,
        signal: AbortSignal.timeout(5_000),
      }).then((r) => r.text());
    } catch {
      // Best effort at shutdown; an abandoned session simply times out on the NAS.
    } finally {
      this.sid = undefined;
      this.synoToken = undefined;
    }
  }

  async close(): Promise<void> {
    await this.logout();
    await Promise.allSettled([this.transports.pooled.close(), this.transports.single.close()]);
  }

  // ---------------------------------------------------------------- calls

  /** Call a DSM API method and return its `data`. */
  async call<T = any>(api: string, method: string, params: Params = {}, options: CallOptions = {}): Promise<T> {
    const entry = await this.entry(api, method);
    const version = this.negotiate(entry, api, method, options);
    const write = options.write ?? !isReadMethod(method);
    await this.ensureSession();

    let sentSid: string | undefined;
    const attempt = async (): Promise<{ success?: boolean; data?: T; error?: { code?: number; errors?: unknown } }> => {
      sentSid = this.sid;
      const body = new URLSearchParams({
        api,
        version: String(version),
        method,
        ...encodeParams(params, { quoteStrings: options.quoteStrings }),
      });
      const response = await fetch(`${this.config.url}/webapi/${entry.path}`, {
        method: 'POST',
        headers: this.headers(),
        body,
        dispatcher: write ? this.transports.single : this.transports.pooled,
        signal: this.signalFor(options),
      });
      return this.parseJson(await response.text(), response.status, api, method) as never;
    };

    let reply = await this.withTransportRetry(attempt, api, method, write, options.signal);
    if (!reply.success && this.isSessionError(reply.error?.code)) {
      await this.relogin(sentSid);
      reply = await this.withTransportRetry(attempt, api, method, write, options.signal);
    }
    if (!reply.success) throw errorFromCode(api, method, reply.error?.code ?? 0, reply.error?.errors);
    return (reply.data ?? ({} as T)) as T;
  }

  /** Call without failing the batch: for aggregate tools where one section may be unavailable. */
  async tryCall<T = any>(
    api: string,
    method: string,
    params: Params = {},
    options: CallOptions = {},
  ): Promise<{ ok: true; data: T } | { ok: false; error: DsmError }> {
    try {
      return { ok: true, data: await this.call<T>(api, method, params, options) };
    } catch (error) {
      return { ok: false, error: this.toDsmError(error, api, method) };
    }
  }

  toDsmError(error: unknown, api?: string, method?: string): DsmError {
    if (error instanceof DsmError) return error;
    return this.mapTransportError(error, api ?? '', method ?? '', true);
  }

  private isSessionError(code: number | undefined): boolean {
    return code !== undefined && (SESSION_CODES.has(code) || code === 150);
  }

  private signalFor(options: CallOptions): AbortSignal {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs);
    return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  }

  private async withTransportRetry<R>(
    attempt: () => Promise<R>,
    api: string,
    method: string,
    write: boolean,
    signal?: AbortSignal,
  ): Promise<R> {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof DsmError && error.kind !== 'unreachable') throw error;
      const mapped = this.mapTransportError(error, api, method, !write);
      // DSM's nginx reload closes keep-alive connections; a read can safely go out once more.
      if (!write && mapped.kind === 'unreachable' && !signal?.aborted) {
        try {
          return await attempt();
        } catch (second) {
          throw second instanceof DsmError ? second : this.mapTransportError(second, api, method, true);
        }
      }
      throw mapped;
    }
  }

  private parseJson(text: string, status: number, api: string, method: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (body && typeof body === 'object' && 'success' in body) return body;
    const retryable = status >= 500;
    throw new DsmError(`DSM answered ${api}/${method} with HTTP ${status} and a reply that is not DSM JSON.`, {
      kind: status >= 500 ? 'unreachable' : 'bad_reply',
      api,
      method,
      retryable,
      hint: 'A reverse proxy may be in front of DSM, or the URL may not be the DSM port.',
    });
  }

  private mapTransportError(error: unknown, api: string, method: string, isRead: boolean): DsmError {
    const seen = new Set<unknown>();
    let current = error as { cause?: unknown; code?: string; name?: string; message?: string } | undefined;
    let code: string | undefined;
    let name: string | undefined;
    let rootMessage: string | undefined;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current instanceof DsmError) return current;
      code = current.code ?? code;
      rootMessage = current.message ?? rootMessage;
      if (current.name === 'TimeoutError' || current.name === 'AbortError') name ??= current.name;
      current = current.cause as typeof current;
    }
    const outcomeUnknown = !isRead;
    const unknown = outcomeUnknown ? ' DSM may still have applied this change; check before retrying.' : '';
    if (name === 'TimeoutError') {
      return new DsmError(`DSM did not answer ${api}/${method} in time.${unknown}`, {
        kind: 'timeout',
        api,
        method,
        retryable: isRead,
        outcomeUnknown,
      });
    }
    if (name === 'AbortError') {
      return new DsmError(`The call to ${api}/${method} was cancelled.${unknown}`, {
        kind: 'timeout',
        api,
        method,
        outcomeUnknown,
      });
    }
    if (code && CERTIFICATE_CODES.has(code)) {
      return new DsmError(`The NAS's TLS certificate is not trusted (${code}).`, {
        kind: 'tls_pin_mismatch',
        api,
        method,
        hint: "DSM's default certificate is self-signed. Run `synology-mcp setup` to pin it.",
      });
    }
    if (code && NETWORK_CODES.has(code)) {
      return new DsmError(`Could not reach the NAS at ${this.config.url} (${code}).${unknown}`, {
        kind: 'unreachable',
        api,
        method,
        retryable: isRead,
        outcomeUnknown,
        hint: 'Check that the VPN or network path to the NAS is up.',
      });
    }
    return new DsmError(`Request to ${api}/${method} failed: ${rootMessage ?? 'unknown error'}.${unknown}`, {
      kind: 'unreachable',
      api,
      method,
      retryable: isRead,
      outcomeUnknown,
    });
  }

  // ---------------------------------------------------------------- binary and streams

  /** GET a binary reply. A JSON reply is DSM reporting an error instead of sending data. */
  private async openBinary(
    api: string,
    method: string,
    params: Params,
    options: CallOptions,
    retried = false,
  ): Promise<Response> {
    const entry = await this.entry(api, method);
    const version = this.negotiate(entry, api, method, options);
    await this.ensureSession();
    const fields = new URLSearchParams({
      api,
      version: String(version),
      method,
      ...encodeParams(params, { quoteStrings: options.quoteStrings }),
    });
    const sentSid = this.sid;
    let response: Response;
    try {
      const url = `${this.config.url}/webapi/${entry.path}`;
      response = await fetch(options.post ? url : `${url}?${fields}`, {
        ...(options.post ? { method: 'POST', body: fields } : {}),
        headers: this.headers(),
        dispatcher: this.transports.single,
        signal: this.signalFor(options),
      });
    } catch (error) {
      throw this.mapTransportError(error, api, method, true);
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body = this.parseJson(await response.text(), response.status, api, method) as {
        error?: { code?: number; errors?: unknown };
      };
      const code = body.error?.code ?? 0;
      if (this.isSessionError(code) && !retried) {
        await this.relogin(sentSid);
        return this.openBinary(api, method, params, options, true);
      }
      throw errorFromCode(api, method, code, body.error?.errors);
    }
    if (!response.ok || type.includes('text/html')) {
      await response.body?.cancel();
      throw new DsmError(`DSM answered ${api}/${method} with HTTP ${response.status} instead of file data.`, {
        kind: response.status === 404 ? 'not_found' : 'bad_reply',
        api,
        method,
      });
    }
    return response;
  }

  /** Read at most maxBytes of a binary reply into memory; `truncated` says if more remained. */
  async readBinary(
    api: string,
    method: string,
    params: Params,
    maxBytes: number,
    options: CallOptions = {},
  ): Promise<{ data: Buffer; truncated: boolean }> {
    const response = await this.openBinary(api, method, params, options);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        const remaining = maxBytes - size;
        if (buffer.length >= remaining) {
          truncated = buffer.length > remaining;
          chunks.push(buffer.subarray(0, remaining));
          size = maxBytes;
          if (truncated) break;
          continue;
        }
        chunks.push(buffer);
        size += buffer.length;
      }
    } catch (error) {
      throw this.mapTransportError(error, api, method, true);
    }
    return { data: Buffer.concat(chunks), truncated };
  }

  /** Stream a binary reply to a file: temp file first, renamed only once complete. */
  async downloadToFile(
    api: string,
    method: string,
    params: Params,
    destination: string,
    options: CallOptions = {},
  ): Promise<number> {
    const response = await this.openBinary(api, method, params, options);
    const temp = `${destination}.${randomBytes(4).toString('hex')}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const { size } = statSync(temp);
      renameSync(temp, destination);
      return size;
    } catch (error) {
      rmSync(temp, { force: true });
      throw error instanceof DsmError ? error : this.mapTransportError(error, api, method, true);
    }
  }

  /** Multipart upload. The file part must come last, and `fields` go in the form as given. */
  async upload<T = any>(
    api: string,
    method: string,
    version: number,
    fields: Record<string, string>,
    file: { blob: Blob; filename: string; field?: string; fieldsAfter?: Record<string, string> },
    options: CallOptions = {},
    retried = false,
  ): Promise<T> {
    const entry = await this.entry(api, method);
    const resolved = this.negotiate(entry, api, method, { ...options, version });
    await this.ensureSession();
    const form = new FormData();
    form.set('api', api);
    form.set('version', String(resolved));
    form.set('method', method);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set(file.field ?? 'file', file.blob, file.filename);
    for (const [key, value] of Object.entries(file.fieldsAfter ?? {})) form.set(key, value);

    const sentSid = this.sid;
    let reply: { success?: boolean; data?: T; error?: { code?: number; errors?: unknown } };
    try {
      const response = await fetch(`${this.config.url}/webapi/${entry.path}`, {
        method: 'POST',
        headers: this.headers(),
        body: form,
        dispatcher: this.transports.single,
        signal: this.signalFor({ timeoutMs: 600_000, ...options }),
      });
      reply = this.parseJson(await response.text(), response.status, api, method) as typeof reply;
    } catch (error) {
      throw error instanceof DsmError ? error : this.mapTransportError(error, api, method, false);
    }
    if (!reply.success && this.isSessionError(reply.error?.code) && !retried) {
      await this.relogin(sentSid);
      return this.upload(api, method, version, fields, file, options, true);
    }
    if (!reply.success) throw errorFromCode(api, method, reply.error?.code ?? 0, reply.error?.errors);
    return (reply.data ?? ({} as T)) as T;
  }

  /**
   * Run a method that answers with chunked text ending in `Exit Code: N`, such as Container
   * Manager's *_stream methods. Keeps only the head and tail of the output in memory.
   */
  async streamText(
    api: string,
    method: string,
    params: Params,
    options: CallOptions & { onChunk?: (bytes: number) => void } = {},
    retried = false,
  ): Promise<{ exitCode: number | undefined; output: string; json?: unknown }> {
    const entry = await this.entry(api, method);
    const version = this.negotiate(entry, api, method, options);
    await this.ensureSession();
    const sentSid = this.sid;
    const HEAD = 16_384;
    const TAIL = 16_384;
    let head = '';
    let tail = '';
    let total = 0;
    try {
      const response = await fetch(`${this.config.url}/webapi/${entry.path}`, {
        method: 'POST',
        headers: this.headers(),
        body: new URLSearchParams({ api, version: String(version), method, ...encodeParams(params) }),
        dispatcher: this.transports.single,
        signal: this.signalFor({ timeoutMs: 900_000, ...options }),
      });
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        total += text.length;
        options.onChunk?.(total);
        if (head.length < HEAD) head += text.slice(0, HEAD - head.length);
        tail = (tail + text).slice(-TAIL);
      }
    } catch (error) {
      throw this.mapTransportError(error, api, method, false);
    }
    const trimmed = head.trimStart();
    if (trimmed.startsWith('{') && total <= HEAD) {
      const body = JSON.parse(trimmed) as { success?: boolean; error?: { code?: number; errors?: unknown } };
      if (body.success === false) {
        const code = body.error?.code ?? 0;
        if (this.isSessionError(code) && !retried) {
          await this.relogin(sentSid);
          return this.streamText(api, method, params, options, true);
        }
        throw errorFromCode(api, method, code, body.error?.errors);
      }
      return { exitCode: 0, output: trimmed, json: body };
    }
    const matches = [...tail.matchAll(/Exit Code:\s*(-?\d+)/g)];
    const last = matches.at(-1);
    const omitted = total - head.length;
    const output = omitted > 0 ? `${head}\n...[${omitted} characters omitted]...\n${tail.slice(-Math.min(TAIL, omitted))}` : head;
    return { exitCode: last ? Number(last[1]) : undefined, output };
  }
}
