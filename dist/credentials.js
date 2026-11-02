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
function quoteForSecurity(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/**
 * `security find-generic-password -w` prints a value with any non-ASCII byte as hex, so what comes
 * back would not match what went in. A secret is stored as base64, which reads back unchanged.
 */
const ENCODED_PREFIX = 'b64:';
function encodeSecret(value) {
    return `${ENCODED_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
}
function decodeSecret(stored) {
    return stored.startsWith(ENCODED_PREFIX) ? Buffer.from(stored.slice(ENCODED_PREFIX.length), 'base64').toString('utf8') : stored;
}
export class KeychainStore {
    name = 'macOS Keychain';
    service(instance) {
        return `${SERVICE_PREFIX}:${instance}`;
    }
    async get(instance, name) {
        try {
            const { stdout } = await exec('security', ['find-generic-password', '-a', name, '-s', this.service(instance), '-w']);
            const value = stdout.replace(/\n$/, '');
            return value ? decodeSecret(value) : undefined;
        }
        catch {
            return undefined;
        }
    }
    set(instance, name, value) {
        return new Promise((resolve, reject) => {
            const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0 && !stderr.trim())
                    resolve();
                else
                    reject(new Error(`Could not write to the Keychain: ${stderr.trim() || `exit code ${code}`}`));
            });
            child.stdin.end(`add-generic-password -U -a ${quoteForSecurity(name)} -s ${quoteForSecurity(this.service(instance))} -w ${quoteForSecurity(encodeSecret(value))}\n`);
        });
    }
    async remove(instance, name) {
        await exec('security', ['delete-generic-password', '-a', name, '-s', this.service(instance)]).catch(() => undefined);
    }
}
/** Fallback for systems without a keychain: a JSON file only the owner can read. */
export class FileStore {
    path;
    name;
    constructor(path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), SERVICE_PREFIX, 'credentials.json')) {
        this.path = path;
        this.name = path;
    }
    read() {
        if (!existsSync(this.path))
            return {};
        return JSON.parse(readFileSync(this.path, 'utf8'));
    }
    write(data) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
        chmodSync(this.path, 0o600);
    }
    async get(instance, name) {
        return this.read()[instance]?.[name];
    }
    async set(instance, name, value) {
        const data = this.read();
        data[instance] = { ...data[instance], [name]: value };
        this.write(data);
    }
    async remove(instance, name) {
        const data = this.read();
        if (data[instance])
            delete data[instance][name];
        this.write(data);
    }
}
export function defaultStore(env = process.env) {
    if (env.SYNOLOGY_SECRET_STORE === 'file')
        return new FileStore();
    return platform() === 'darwin' ? new KeychainStore() : new FileStore();
}
/** Stores to look in, most preferred first. */
function lookupStores(primary) {
    return primary instanceof FileStore ? [primary] : [primary, new FileStore()];
}
export class CredentialProvider {
    instance;
    username;
    store;
    env;
    constructor(instance, username, store = defaultStore(), env = process.env) {
        this.instance = instance;
        this.username = username;
        this.store = store;
        this.env = env;
    }
    async lookup(name) {
        for (const store of lookupStores(this.store)) {
            const value = await store.get(this.instance, name);
            if (value)
                return value;
        }
        return undefined;
    }
    async resolve() {
        const username = this.env.SYNOLOGY_USERNAME || this.username;
        const password = this.env.SYNOLOGY_PASSWORD || (await this.lookup('password'));
        if (!username || !password)
            return undefined;
        const deviceId = this.env.SYNOLOGY_DEVICE_ID || (await this.lookup('device_id'));
        return { username, password, deviceId };
    }
    /** The login for the Spreadsheet API container: its own account if set, else the main one. */
    async resolveSpreadsheet(dedicatedUsername) {
        if (dedicatedUsername) {
            const password = this.env.SYNOLOGY_SPREADSHEET_PASSWORD || (await this.lookup('spreadsheet_password'));
            return password ? { username: dedicatedUsername, password } : undefined;
        }
        const main = await this.resolve();
        return main ? { username: main.username, password: main.password } : undefined;
    }
    saveSpreadsheetPassword(value) {
        return this.store.set(this.instance, 'spreadsheet_password', value);
    }
    async sources() {
        return {
            password: this.env.SYNOLOGY_PASSWORD ? 'env' : (await this.lookup('password')) ? 'store' : 'missing',
            deviceId: this.env.SYNOLOGY_DEVICE_ID ? 'env' : (await this.lookup('device_id')) ? 'store' : 'missing',
        };
    }
    /** True if a value in the environment would override what `setup` stores. */
    get envOverridesDeviceId() {
        return Boolean(this.env.SYNOLOGY_DEVICE_ID);
    }
    saveDeviceId(value) {
        return this.store.set(this.instance, 'device_id', value);
    }
    savePassword(value) {
        return this.store.set(this.instance, 'password', value);
    }
    removeDeviceId() {
        return this.store.remove(this.instance, 'device_id');
    }
    get storeName() {
        return this.store.name;
    }
}
