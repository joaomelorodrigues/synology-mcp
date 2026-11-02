/**
 * The escape hatch that makes coverage complete: any of the NAS's DSM APIs can be found and
 * called, within firm limits. Credential, factory-reset and disk-layout operations stay out of
 * reach even at the admin tier, because no conversation should be able to wipe a NAS.
 */

import { z } from 'zod';
import { isReadMethod } from '../dsm/client.js';
import { DsmError } from '../dsm/errors.js';
import { redactSecrets } from '../mcp/format.js';
import { confirmationNeeded, tool, type ToolDef } from '../mcp/registry.js';

/** Never callable here, reads included: credentials, keys and account recovery. */
const NEVER = [
  /^SYNO\.API\.(Auth|OTP|Encryption)/,
  /^SYNO\.Core\.OTP/,
  /^SYNO\.Core\.TrustDevice/,
  /^SYNO\.SecureSignIn/,
  /^SYNO\.Core\.ResetAdmin/,
  /^SYNO\.Core\.Factory/,
  /^SYNO\.Core\.User\.PasswordConfirm/,
  /^SYNO\.Core\.Share\.(KeyManager|Crypto)/,
  /^SYNO\.Storage\.CGI\.(EncryptionKeyVault|KMIP)/,
  /^SYNO\.Core\.Certificate\.LetsEncrypt\.Account/,
];

/** On these APIs only read methods are allowed: changes here can destroy every volume. */
const STORAGE_LAYOUT = /^SYNO\.(Storage\.CGI\.|Core\.Storage\.)/;

const POWER_ONLY: { api: RegExp; method: RegExp }[] = [
  { api: /^SYNO\.Core\.System$/, method: /^(reboot|shutdown)$/i },
  { api: /^SYNO\.Core\.Upgrade/, method: /^(?!get|list|check|status|load)/i },
];

export function assertCallAllowed(api: string, method: string, options: { allowPower: boolean }): void {
  if (!api.startsWith('SYNO.')) {
    throw new DsmError(`"${api}" is not a DSM API name.`, { kind: 'invalid_parameter' });
  }
  if (NEVER.some((pattern) => pattern.test(api))) {
    throw new DsmError(`${api} handles credentials or account recovery and is never callable through this tool.`, {
      kind: 'refused',
      hint: 'Do this in DSM itself.',
    });
  }
  if (STORAGE_LAYOUT.test(api) && !isReadMethod(method)) {
    throw new DsmError(`${api}/${method} could change disks or volumes, which this server does not do.`, {
      kind: 'refused',
      hint: 'Use Storage Manager in DSM.',
    });
  }
  if (!options.allowPower && POWER_ONLY.some((rule) => rule.api.test(api) && rule.method.test(method))) {
    throw new DsmError(`${api}/${method} reboots, shuts down or updates the NAS, and power tools are off on this connection.`, {
      kind: 'refused',
      hint: 'Set allowPower: true in the config to enable power tools.',
    });
  }
}

const callInput = {
  api: z.string().describe('e.g. SYNO.Core.Quota'),
  method: z.string().describe('e.g. list'),
  version: z.number().int().min(1).optional().describe('Defaults to the newest version offered'),
  params: z.record(z.string(), z.unknown()).default({}).describe('Parameters. Lists and objects are JSON-encoded.'),
  raw_strings: z
    .boolean()
    .default(false)
    .describe('Send strings unquoted. Strings are JSON-quoted by default, as DSM\'s web client does; set this if the API rejects that.'),
};

export const genericTools: ToolDef[] = [
  tool({
    name: 'dsm_api_search',
    title: 'Search DSM APIs',
    description:
      "Search this NAS's own list of DSM APIs by keyword, for anything no dedicated tool covers. Returns names and versions; method names are not listed by DSM, but are usually get, list, set, create, delete.",
    module: 'generic',
    tier: 'read',
    input: {
      query: z.string().describe('Words to find in the API name, e.g. "vpn connection" or "webstation"'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    handler: async ({ query, limit }, { client }) => {
      const catalog = await client.catalog();
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...catalog.entries()]
        .filter(([name]) => words.every((word) => name.toLowerCase().includes(word)))
        .sort(([a], [b]) => a.localeCompare(b));
      return {
        total_on_nas: catalog.size,
        matches: matches.length,
        apis: matches.slice(0, limit).map(([name, entry]) => ({
          api: name,
          versions: entry.minVersion === entry.maxVersion ? `${entry.maxVersion}` : `${entry.minVersion}-${entry.maxVersion}`,
        })),
      };
    },
  }),

  tool({
    name: 'dsm_read',
    title: 'Call any DSM read method',
    description:
      'Call a read method (get*, list*, load*, query*, status*, count*, check*, info*, search*) on any DSM API. Use when no dedicated tool fits. Password- and token-shaped fields are redacted.',
    module: 'generic',
    tier: 'read',
    input: callInput,
    handler: async ({ api, method, version, params, raw_strings }, { client, config, signal }) => {
      if (!isReadMethod(method)) {
        throw new DsmError(`"${method}" does not look like a read method, so dsm_read will not call it.`, {
          kind: 'refused',
          hint: 'If it changes something, use dsm_write, which needs the admin tier.',
        });
      }
      assertCallAllowed(api, method, { allowPower: config.allowPower });
      const data = await client.call(api, method, params as never, { version, write: false, quoteStrings: !raw_strings, signal });
      return redactSecrets(data);
    },
  }),

  tool({
    name: 'dsm_write',
    title: 'Call any DSM method',
    description:
      'Call any method that changes state on any DSM API, for what no dedicated tool covers. The first call previews; confirm=true sends it. Credential, recovery and disk-layout APIs are refused.',
    module: 'generic',
    tier: 'admin',
    input: {
      ...callInput,
      confirm: z.boolean().default(false),
    },
    handler: async ({ api, method, version, params, raw_strings, confirm }, { client, config, signal }) => {
      assertCallAllowed(api, method, { allowPower: config.allowPower });
      if (!client.has(api)) {
        throw new DsmError(`${api} is not available on this NAS.`, { kind: 'api_not_found', hint: 'Check dsm_api_search.' });
      }
      if (!confirm) {
        return confirmationNeeded({
          would_call: `${api}/${method}`,
          version: version ?? 'newest',
          params: redactSecrets(params),
          warning: 'This call has no dedicated safety checks. Make sure you know what it does.',
        });
      }
      const data = await client.call(api, method, params as never, { version, write: true, quoteStrings: !raw_strings, signal, timeoutMs: 120_000 });
      return redactSecrets(data);
    },
  }),
];
