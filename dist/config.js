/**
 * Configuration: environment variables override the config file, the config file overrides
 * defaults. The file never holds secrets; see credentials.ts for those.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
export const TIERS = ['read', 'write', 'admin'];
export const MODULES = [
    'system',
    'storage',
    'files',
    'docker',
    'packages',
    'accounts',
    'services',
    'security',
    'network',
    'backup',
    'scheduler',
    'photos',
    'drive',
    'downloads',
    'vm',
    'surveillance',
    'generic',
];
const fileSchema = z.strictObject({
    /** DSM base URL including the DSM port, e.g. https://nas.example.com:5001 */
    url: z.url().optional(),
    username: z.string().min(1).optional(),
    /** read: no changes. write: reversible changes. admin: destructive changes and account management. */
    tier: z.enum(TIERS).optional(),
    /** Enables reboot, shutdown and DSM update installation. Separate from tier on purpose. */
    allowPower: z.boolean().optional(),
    /** Modules to load, or "all". Tools for packages missing on the NAS are hidden either way. */
    modules: z.union([z.literal('all'), z.array(z.enum(MODULES))]).optional(),
    certFingerprint: z.string().optional(),
    insecureTls: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    /** Local folders upload and download tools may touch. */
    localRoots: z.array(z.string()).optional(),
    /** NAS paths that no tool may change or delete, at or below the given path. */
    protectedPaths: z.array(z.string()).optional(),
    deviceName: z.string().min(1).optional(),
    maxOutputChars: z.number().int().min(1000).max(2_000_000).optional(),
    /** Extra guidance prepended to the server's instructions. */
    instructions: z.string().optional(),
});
export class ConfigError extends Error {
}
export function defaultConfigPath(env = process.env) {
    if (env.SYNOLOGY_CONFIG)
        return resolve(expandHome(env.SYNOLOGY_CONFIG));
    const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    return join(base, 'synology-mcp', 'config.json');
}
export function stateDir(env = process.env) {
    const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
    return join(base, 'synology-mcp');
}
export function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return join(homedir(), path.slice(2));
    return path;
}
function readFileConfig(path) {
    if (!existsSync(path))
        return {};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
    }
    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new ConfigError(`Invalid config in ${path}: ${issues}`);
    }
    return result.data;
}
function envBool(value) {
    if (value === undefined || value === '')
        return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
function envList(value) {
    if (value === undefined || value.trim() === '')
        return undefined;
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
function envModules(value) {
    const list = envList(value);
    if (!list)
        return undefined;
    if (list.length === 1 && list[0] === 'all')
        return 'all';
    const unknown = list.filter((m) => !MODULES.includes(m));
    if (unknown.length) {
        throw new ConfigError(`SYNOLOGY_MODULES has unknown modules: ${unknown.join(', ')}. Valid: ${MODULES.join(', ')}`);
    }
    return list;
}
function envTier(value) {
    if (!value)
        return undefined;
    if (!TIERS.includes(value)) {
        throw new ConfigError(`SYNOLOGY_TIER must be one of ${TIERS.join(', ')}; got "${value}".`);
    }
    return value;
}
export function loadConfig(options = {}) {
    const env = options.env ?? process.env;
    const configPath = options.path ? resolve(expandHome(options.path)) : defaultConfigPath(env);
    const file = readFileConfig(configPath);
    const url = (env.SYNOLOGY_URL ?? file.url ?? '').replace(/\/+$/, '');
    if (!url && !options.allowMissingUrl) {
        throw new ConfigError(`No NAS URL configured. Run \`synology-mcp setup\`, or set SYNOLOGY_URL. (Looked in ${configPath})`);
    }
    if (url) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new ConfigError(`NAS URL is not valid: "${url}"`);
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new ConfigError(`NAS URL must be http or https; got "${parsed.protocol}".`);
        }
    }
    const certFingerprint = env.SYNOLOGY_CERT_FINGERPRINT ?? file.certFingerprint;
    if (certFingerprint && url.startsWith('http:')) {
        throw new ConfigError('A certificate fingerprint is set but the NAS URL is plain http. Use the https URL.');
    }
    return {
        url,
        username: env.SYNOLOGY_USERNAME ?? file.username,
        tier: envTier(env.SYNOLOGY_TIER) ?? file.tier ?? 'read',
        allowPower: envBool(env.SYNOLOGY_ALLOW_POWER) ?? file.allowPower ?? false,
        modules: envModules(env.SYNOLOGY_MODULES) ?? file.modules ?? 'all',
        certFingerprint,
        insecureTls: envBool(env.SYNOLOGY_INSECURE_TLS) ?? file.insecureTls ?? false,
        timeoutMs: env.SYNOLOGY_TIMEOUT_MS ? Number(env.SYNOLOGY_TIMEOUT_MS) : (file.timeoutMs ?? 30_000),
        localRoots: (envList(env.SYNOLOGY_LOCAL_ROOTS) ?? file.localRoots ?? ['~/Downloads']).map(expandHome),
        protectedPaths: envList(env.SYNOLOGY_PROTECTED_PATHS) ?? file.protectedPaths ?? [],
        deviceName: env.SYNOLOGY_DEVICE_NAME ?? file.deviceName ?? 'synology-mcp',
        maxOutputChars: env.SYNOLOGY_MAX_OUTPUT_CHARS ? Number(env.SYNOLOGY_MAX_OUTPUT_CHARS) : (file.maxOutputChars ?? 40_000),
        instructions: file.instructions,
        configPath,
    };
}
/** Merge values into the config file. Only non-secret settings ever reach this file. */
export function saveFileConfig(path, values) {
    const merged = fileSchema.parse({ ...readFileConfig(path), ...values });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}
/** Stable key for credentials and cached state: scheme, host and port. */
export function instanceKey(url) {
    const parsed = new URL(url);
    return parsed.host;
}
