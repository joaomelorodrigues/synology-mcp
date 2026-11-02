/**
 * Secret storage. Lookup order: environment, then the macOS Keychain, then a 0600 file for
 * systems without one. Keychain writes go through `security -i` on stdin, so a secret never
 * appears in a process list. Secrets are read fresh on each login, so `setup` takes effect in
 * a running server without a restart.
 */

import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SERVICE_PREFIX = 'synology-mcp';

export type SecretName = 'password' | 'device_id' | 'spreadsheet_password';

export interface Credentials {
  username: string;
  password: string;
  deviceId?: string;
}

export interface SecretStore {
  readonly name: string;
  get(instance: string, name: SecretName): Promise<string | undefined>;
  set(instance: string, name: SecretName, value: string): Promise<void>;
  remove(instance: string, name: SecretName): Promise<void>;
}

function quoteForSecurity(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `security find-generic-password -w` prints a value with any non-ASCII byte as hex, so what comes
 * back would not match what went in. A secret is stored as base64, which reads back unchanged.
 */
const ENCODED_PREFIX = 'b64:';

function encodeSecret(value: string): string {
  return `${ENCODED_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decodeSecret(stored: string): string {
  return stored.startsWith(ENCODED_PREFIX) ? Buffer.from(stored.slice(ENCODED_PREFIX.length), 'base64').toString('utf8') : stored;
}

export class KeychainStore implements SecretStore {
  readonly name = 'macOS Keychain';

  private service(instance: string): string {
    return `${SERVICE_PREFIX}:${instance}`;
  }

  async get(instance: string, name: SecretName): Promise<string | undefined> {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-a', name, '-s', this.service(instance), '-w']);
      const value = stdout.replace(/\n$/, '');
      return value ? decodeSecret(value) : undefined;
    } catch {
      return undefined;
    }
  }

  set(instance: string, name: SecretName, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && !stderr.trim()) resolve();
        else reject(new Error(`Could not write to the Keychain: ${stderr.trim() || `exit code ${code}`}`));
      });
      child.stdin.end(
        `add-generic-password -U -a ${quoteForSecurity(name)} -s ${quoteForSecurity(this.service(instance))} -w ${quoteForSecurity(encodeSecret(value))}\n`,
      );
    });
  }

  async remove(instance: string, name: SecretName): Promise<void> {
    await exec('security', ['delete-generic-password', '-a', name, '-s', this.service(instance)]).catch(() => undefined);
  }
}

/** Fallback for systems without a keychain: a JSON file only the owner can read. */
export class FileStore implements SecretStore {
  readonly name: string;

  constructor(private readonly path: string = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), SERVICE_PREFIX, 'credentials.json')) {
    this.name = path;
  }

  private read(): Record<string, Partial<Record<SecretName, string>>> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Partial<Record<SecretName, string>>>;
  }

  private write(data: Record<string, Partial<Record<SecretName, string>>>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  async get(instance: string, name: SecretName): Promise<string | undefined> {
    return this.read()[instance]?.[name];
  }

  async set(instance: string, name: SecretName, value: string): Promise<void> {
    const data = this.read();
    data[instance] = { ...data[instance], [name]: value };
    this.write(data);
  }

  async remove(instance: string, name: SecretName): Promise<void> {
    const data = this.read();
    if (data[instance]) delete data[instance][name];
    this.write(data);
  }
}

export function defaultStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (env.SYNOLOGY_SECRET_STORE === 'file') return new FileStore();
  return platform() === 'darwin' ? new KeychainStore() : new FileStore();
}

/** Stores to look in, most preferred first. */
function lookupStores(primary: SecretStore): SecretStore[] {
  return primary instanceof FileStore ? [primary] : [primary, new FileStore()];
}

export interface CredentialSources {
  password: 'env' | 'store' | 'missing';
  deviceId: 'env' | 'store' | 'missing';
}

export class CredentialProvider {
  constructor(
    private readonly instance: string,
    private readonly username: string | undefined,
    private readonly store: SecretStore = defaultStore(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async lookup(name: SecretName): Promise<string | undefined> {
    for (const store of lookupStores(this.store)) {
      const value = await store.get(this.instance, name);
      if (value) return value;
    }
    return undefined;
  }

  async resolve(): Promise<Credentials | undefined> {
    const username = this.env.SYNOLOGY_USERNAME || this.username;
    const password = this.env.SYNOLOGY_PASSWORD || (await this.lookup('password'));
    if (!username || !password) return undefined;
    const deviceId = this.env.SYNOLOGY_DEVICE_ID || (await this.lookup('device_id'));
    return { username, password, deviceId };
  }

  /** The login for the Spreadsheet API container: its own account if set, else the main one. */
  async resolveSpreadsheet(dedicatedUsername?: string): Promise<{ username: string; password: string } | undefined> {
    if (dedicatedUsername) {
      const password = this.env.SYNOLOGY_SPREADSHEET_PASSWORD || (await this.lookup('spreadsheet_password'));
      return password ? { username: dedicatedUsername, password } : undefined;
    }
    const main = await this.resolve();
    return main ? { username: main.username, password: main.password } : undefined;
  }

  saveSpreadsheetPassword(value: string): Promise<void> {
    return this.store.set(this.instance, 'spreadsheet_password', value);
  }

  async sources(): Promise<CredentialSources> {
    return {
      password: this.env.SYNOLOGY_PASSWORD ? 'env' : (await this.lookup('password')) ? 'store' : 'missing',
      deviceId: this.env.SYNOLOGY_DEVICE_ID ? 'env' : (await this.lookup('device_id')) ? 'store' : 'missing',
    };
  }

  /** True if a value in the environment would override what `setup` stores. */
  get envOverridesDeviceId(): boolean {
    return Boolean(this.env.SYNOLOGY_DEVICE_ID);
  }

  saveDeviceId(value: string): Promise<void> {
    return this.store.set(this.instance, 'device_id', value);
  }

  savePassword(value: string): Promise<void> {
    return this.store.set(this.instance, 'password', value);
  }

  removeDeviceId(): Promise<void> {
    return this.store.remove(this.instance, 'device_id');
  }

  get storeName(): string {
    return this.store.name;
  }
}
