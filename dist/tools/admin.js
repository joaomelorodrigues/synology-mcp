/** Packages, file services, security, network services, Hyper Backup and Task Scheduler. */
import { z } from 'zod';
import { DsmError } from '../dsm/errors.js';
import { asList, isoTime } from '../mcp/format.js';
import { confirmationNeeded, tool } from '../mcp/registry.js';
const RP = 'SYNO.Core.AppPortal.ReverseProxy';
/** How an unavailable section reads in an aggregate reply. */
function section(result, pick) {
    return result.ok ? pick(result.data) : { unavailable: result.error.message };
}
export const packageTools = [
    tool({
        name: 'packages_list',
        title: 'List packages',
        description: 'Installed DSM packages with version and running status, running first.',
        module: 'packages',
        tier: 'read',
        requires: ['SYNO.Core.Package'],
        input: { running_only: z.boolean().default(false) },
        handler: async ({ running_only }, { client, signal }) => {
            const data = await client.call('SYNO.Core.Package', 'list', { additional: ['status'] }, { version: 2, signal });
            const packages = asList(data.packages)
                .map((p) => ({ id: p.id, name: p.name, version: p.version, status: p.additional?.status }))
                .filter((p) => !running_only || p.status === 'running')
                .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || String(a.name).localeCompare(String(b.name)));
            return { total: packages.length, packages };
        },
    }),
    tool({
        name: 'package_control',
        title: 'Start or stop a package',
        description: 'Start or stop an installed package, by id from packages_list. Stopping one can cut off whatever depends on it, including the VPN or the web server this connection may use: stop needs confirm=true.',
        module: 'packages',
        tier: 'write',
        destructive: true,
        idempotent: true,
        requires: ['SYNO.Core.Package.Control'],
        input: {
            id: z.string(),
            action: z.enum(['start', 'stop']),
            confirm: z.boolean().default(false),
        },
        handler: async ({ id, action, confirm }, { client }) => {
            if (action === 'stop' && !confirm) {
                return confirmationNeeded({ would_stop_package: id, warning: 'Anything depending on it stops working until it is started again.' });
            }
            await client.call('SYNO.Core.Package.Control', action, { id }, { version: 1, timeoutMs: 180_000 });
            return { package: id, action, done: true };
        },
    }),
];
const FILE_SERVICES = {
    smb: ['SYNO.Core.FileServ.SMB', 'enable_samba'],
    afp: ['SYNO.Core.FileServ.AFP', 'enable_afp'],
    nfs: ['SYNO.Core.FileServ.NFS', 'enable_nfs'],
    ftp: ['SYNO.Core.FileServ.FTP', 'enable_ftp'],
};
export const serviceTools = [
    tool({
        name: 'services_status',
        title: 'File and terminal services',
        description: 'Whether SMB, AFP, NFS, FTP, SFTP, SSH, Telnet and SNMP are on, with their key settings.',
        module: 'services',
        tier: 'read',
        requiresAny: ['SYNO.Core.FileServ.SMB', 'SYNO.Core.Terminal'],
        handler: async (_args, { client, signal }) => {
            const get = (api, version) => client.tryCall(api, 'get', {}, { version, signal });
            const [smb, afp, nfs, ftp, sftp, terminal, snmp] = await Promise.all([
                get('SYNO.Core.FileServ.SMB', 2),
                get('SYNO.Core.FileServ.AFP', 2),
                get('SYNO.Core.FileServ.NFS', 2),
                get('SYNO.Core.FileServ.FTP', 2),
                get('SYNO.Core.FileServ.FTP.SFTP', 1),
                get('SYNO.Core.Terminal', 3),
                get('SYNO.Core.SNMP', 1),
            ]);
            return {
                smb: section(smb, (d) => ({ on: d.enable_samba, smb2: d.enable_smb2, workgroup: d.workgroup })),
                afp: section(afp, (d) => ({ on: d.enable_afp })),
                nfs: section(nfs, (d) => ({ on: d.enable_nfs, v4: d.enable_nfs_v4 })),
                ftp: section(ftp, (d) => ({ on: d.enable_ftp, ftps: d.enable_ftps, port: d.portnum })),
                sftp: section(sftp, (d) => ({ on: d.enable, port: d.portnum })),
                ssh: section(terminal, (d) => ({ on: d.enable_ssh, port: d.ssh_port })),
                telnet: section(terminal, (d) => ({ on: d.enable_telnet })),
                snmp: section(snmp, (d) => ({ on: d.enable_snmp, v1v2: d.enable_snmp_v1v2, v3: d.enable_snmp_v3 })),
            };
        },
    }),
    tool({
        name: 'service_set',
        title: 'Turn a file service on or off',
        description: 'Turn SMB, AFP, NFS or FTP on or off. Turning one off disconnects everyone using it. Requires confirm=true.',
        module: 'services',
        tier: 'admin',
        idempotent: true,
        requires: ['SYNO.Core.FileServ.SMB'],
        input: {
            service: z.enum(['smb', 'afp', 'nfs', 'ftp']),
            enabled: z.boolean(),
            confirm: z.boolean().default(false),
        },
        handler: async ({ service, enabled, confirm }, { client, signal }) => {
            if (!confirm) {
                return confirmationNeeded({
                    would: `turn ${service} ${enabled ? 'on' : 'off'}`,
                    warning: enabled ? 'This exposes a file-sharing protocol on the network.' : 'Everyone connected through it is disconnected.',
                });
            }
            const [api, field] = FILE_SERVICES[service];
            await client.call(api, 'set', { [field]: enabled }, { version: 2, signal, timeoutMs: 60_000 });
            return { service, enabled };
        },
    }),
];
export const securityTools = [
    tool({
        name: 'security_overview',
        title: 'Security overview',
        description: 'Security Advisor result, session timeout, CSRF and IP checks, Auto Block policy, firewall profile and DoS protection.',
        module: 'security',
        tier: 'read',
        requiresAny: ['SYNO.Core.Security.DSM', 'SYNO.Core.SecurityScan.Status'],
        handler: async (_args, { client, signal }) => {
            const [dsm, autoblock, firewall, profiles, scan, dos] = await Promise.all([
                client.tryCall('SYNO.Core.Security.DSM', 'get', {}, { version: 6, signal }),
                client.tryCall('SYNO.Core.Security.AutoBlock', 'get', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.Security.Firewall', 'get', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.Security.Firewall.Profile', 'list', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.SecurityScan.Status', 'system_get', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.Security.DoS', 'get', { configs: [{ adapter: '' }] }, { version: 1, signal }),
            ]);
            return {
                advisor: section(scan, (d) => ({
                    status: d.sysStatus,
                    last_scan: isoTime(d.lastScanTime) ?? d.lastScanTime,
                    categories: Object.fromEntries(Object.entries(d.items ?? {}).map(([name, info]) => [
                        name,
                        {
                            severity: info.failSeverity,
                            issues: Object.fromEntries(Object.entries(info.fail ?? {}).filter(([, count]) => count)),
                        },
                    ])),
                })),
                dsm: section(dsm, (d) => ({
                    session_timeout_min: d.timeout,
                    csrf_protection: d.enable_csrf_protection,
                    skip_ip_check: d.skip_ip_checking,
                    stay_signed_in_allowed: d.allow_stay_signed_in_option,
                })),
                auto_block: section(autoblock, (d) => ({ on: d.enable, attempts: d.attempts, within_min: d.within_mins, block_days: d.expire_day })),
                firewall: section(firewall, (d) => ({ on: d.enable_firewall, profile: d.profile_name })),
                firewall_profiles: section(profiles, (d) => d.profile_names ?? d.profiles),
                dos_protection: section(dos, (d) => d),
            };
        },
    }),
    tool({
        name: 'security_certificates',
        title: 'TLS certificates',
        description: 'Installed TLS certificates with validity, issuer and the services using each, expiring first.',
        module: 'security',
        tier: 'read',
        requires: ['SYNO.Core.Certificate.CRT'],
        handler: async (_args, { client, signal }) => {
            const data = await client.call('SYNO.Core.Certificate.CRT', 'list', {}, { version: 1, signal });
            const name = (value) => (typeof value === 'object' ? value?.common_name : value);
            const certificates = asList(data.certificates)
                .map((c) => ({
                id: c.id,
                description: c.desc,
                subject: name(c.subject),
                issuer: name(c.issuer),
                valid_from: c.valid_from,
                valid_till: c.valid_till,
                is_default: c.is_default || undefined,
                broken: c.is_broken || undefined,
                renewable: c.renewable,
                services: asList(c.services).map((s) => s.display_name ?? s.service ?? s),
            }))
                .sort((a, b) => Date.parse(a.valid_till ?? '') - Date.parse(b.valid_till ?? ''));
            return { total: certificates.length, certificates };
        },
    }),
    tool({
        name: 'security_login_activity',
        title: 'Login activity',
        description: 'Recent sign-ins from Security Advisor, plus the IP addresses Auto Block has blocked.',
        module: 'security',
        tier: 'read',
        requiresAny: ['SYNO.SecurityAdvisor.LoginActivity', 'SYNO.Core.Security.AutoBlock.Rules'],
        input: { limit: z.number().int().min(1).max(500).default(50) },
        handler: async ({ limit }, { client, signal }) => {
            const [activity, blocked] = await Promise.all([
                client.tryCall('SYNO.SecurityAdvisor.LoginActivity', 'list', { offset: 0, limit }, { version: 1, signal }),
                client.tryCall('SYNO.Core.Security.AutoBlock.Rules', 'list', { offset: 0, limit: 200, type: 'deny' }, { version: 1, signal }),
            ]);
            return {
                logins: section(activity, (d) => d.items ?? d.logs ?? d),
                blocked_ips: section(blocked, (d) => d.rules ?? d.items ?? d),
            };
        },
    }),
];
export const networkTools = [
    tool({
        name: 'network_services',
        title: 'DDNS and QuickConnect',
        description: 'DDNS records (hostname, external IP, status) and QuickConnect state.',
        module: 'network',
        tier: 'read',
        requiresAny: ['SYNO.Core.DDNS.Record', 'SYNO.Core.QuickConnect'],
        handler: async (_args, { client, signal }) => {
            const [ddns, quick] = await Promise.all([
                client.tryCall('SYNO.Core.DDNS.Record', 'list', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.QuickConnect', 'get', {}, { version: 1, signal }),
            ]);
            return {
                ddns: section(ddns, (d) => ({
                    next_update: d.next_update_time,
                    records: asList(d.records).map((r) => ({
                        hostname: r.hostname,
                        provider: r.provider ?? r.id,
                        ip: r.ip,
                        status: r.status,
                        on: r.enable,
                        last_updated: r.lastupdated,
                    })),
                })),
                quickconnect: section(quick, (d) => ({ on: d.enabled, id: d.server_alias, region: d.region, domain: d.domain })),
            };
        },
    }),
    tool({
        name: 'reverse_proxy_list',
        title: 'List reverse proxy rules',
        description: 'Login Portal reverse proxy rules: source host and port, destination, timeouts and headers.',
        module: 'network',
        tier: 'read',
        requires: [RP],
        handler: async (_args, { client, signal }) => {
            const data = await client.call(RP, 'list', {}, { version: 1, signal });
            const proto = (value) => (value === 1 ? 'HTTPS' : value === 0 ? 'HTTP' : value);
            return {
                rules: asList(data.entries).map((e) => ({
                    uuid: e.UUID ?? e.uuid,
                    description: e.description,
                    from: `${proto(e.frontend?.protocol)}://${e.frontend?.fqdn}:${e.frontend?.port}`,
                    to: `${proto(e.backend?.protocol)}://${e.backend?.fqdn}:${e.backend?.port}`,
                    hsts: e.frontend?.https?.hsts || undefined,
                    websocket: asList(e.customize_headers).some((h) => String(h.name).toLowerCase() === 'upgrade') || undefined,
                })),
            };
        },
    }),
    tool({
        name: 'reverse_proxy_create',
        title: 'Create a reverse proxy rule',
        description: 'Add a Login Portal reverse proxy rule. This can expose an internal service to whoever can reach the NAS. DSM reloads its web server when saving, so it may take a moment. Requires confirm=true.',
        module: 'network',
        tier: 'admin',
        requires: [RP],
        input: {
            description: z.string().min(1).describe('Must be unique; it is how DSM identifies the new rule'),
            source_host: z.string(),
            source_port: z.number().int().min(1).max(65535).default(443),
            source_https: z.boolean().default(true),
            destination_host: z.string(),
            destination_port: z.number().int().min(1).max(65535),
            destination_https: z.boolean().default(false),
            websocket: z.boolean().default(false),
            hsts: z.boolean().default(false),
            confirm: z.boolean().default(false),
        },
        handler: async (args, { client, signal }) => {
            const source = `${args.source_https ? 'https' : 'http'}://${args.source_host}:${args.source_port}`;
            const destination = `${args.destination_https ? 'https' : 'http'}://${args.destination_host}:${args.destination_port}`;
            if (args.hsts && !args.source_https)
                throw new DsmError('hsts needs an HTTPS source.', { kind: 'invalid_parameter' });
            const existing = await client.call(RP, 'list', {}, { version: 1, signal });
            if (asList(existing.entries).some((e) => e.description === args.description)) {
                throw new DsmError(`A rule described "${args.description}" already exists.`, { kind: 'already_exists' });
            }
            if (!args.confirm)
                return confirmationNeeded({ would_forward: `${source} to ${destination}`, warning: 'Whoever can reach the source can reach this service.' });
            const entry = {
                description: args.description,
                proxy_connect_timeout: 60,
                proxy_read_timeout: 60,
                proxy_send_timeout: 60,
                proxy_http_version: 1,
                proxy_intercept_errors: false,
                frontend: { acl: null, fqdn: args.source_host, port: args.source_port, protocol: args.source_https ? 1 : 0, https: { hsts: args.hsts } },
                backend: { fqdn: args.destination_host, port: args.destination_port, protocol: args.destination_https ? 1 : 0 },
                customize_headers: args.websocket
                    ? [
                        { name: 'Upgrade', value: '$http_upgrade' },
                        { name: 'Connection', value: '$connection_upgrade' },
                    ]
                    : [],
            };
            // DSM rewrites and reloads nginx before answering, which can take well over a minute.
            await client.call(RP, 'create', { entry }, { version: 1, signal, timeoutMs: 120_000 });
            return { created: args.description, from: source, to: destination };
        },
    }),
    tool({
        name: 'reverse_proxy_delete',
        title: 'Delete a reverse proxy rule',
        description: 'Delete a reverse proxy rule by uuid from reverse_proxy_list. The first call previews; confirm=true deletes.',
        module: 'network',
        tier: 'admin',
        requires: [RP],
        input: {
            uuid: z.string(),
            confirm: z.boolean().default(false),
        },
        handler: async ({ uuid, confirm }, { client, signal }) => {
            const existing = await client.call(RP, 'list', {}, { version: 1, signal });
            const match = asList(existing.entries).find((e) => (e.UUID ?? e.uuid) === uuid);
            if (!match)
                throw new DsmError(`No reverse proxy rule with uuid ${uuid}.`, { kind: 'not_found' });
            if (!confirm) {
                return confirmationNeeded({
                    would_delete: match.description,
                    from: `${match.frontend?.fqdn}:${match.frontend?.port}`,
                    to: `${match.backend?.fqdn}:${match.backend?.port}`,
                });
            }
            await client.call(RP, 'delete', { uuids: [uuid] }, { version: 1, signal, timeoutMs: 120_000 });
            return { deleted: match.description };
        },
    }),
];
export const backupTools = [
    tool({
        name: 'backup_tasks',
        title: 'Hyper Backup tasks',
        description: 'Hyper Backup tasks with state, target and encryption. Needs the Hyper Backup package.',
        module: 'backup',
        tier: 'read',
        requires: ['SYNO.Backup.Task'],
        handler: async (_args, { client, signal }) => {
            const data = await client.call('SYNO.Backup.Task', 'list', {}, { version: 1, signal });
            return {
                total: data.total,
                restoring: data.is_restoring,
                tasks: asList(data.task_list).map((t) => ({
                    id: t.task_id,
                    name: t.name,
                    state: t.state,
                    status: t.status,
                    target: t.target_id,
                    type: t.type,
                    encrypted: t.data_enc,
                })),
            };
        },
    }),
    tool({
        name: 'backup_run',
        title: 'Run a backup now',
        description: 'Start a Hyper Backup task now, by id from backup_tasks.',
        module: 'backup',
        tier: 'write',
        destructive: false,
        requires: ['SYNO.Backup.Task'],
        input: { task_id: z.number().int() },
        handler: async ({ task_id }, { client, signal }) => {
            await client.call('SYNO.Backup.Task', 'backup', { task_id }, { version: 1, signal });
            return { task_id, started: true };
        },
    }),
];
export const schedulerTools = [
    tool({
        name: 'scheduler_tasks',
        title: 'Scheduled tasks',
        description: 'Task Scheduler entries: type, owner, enabled, next run.',
        module: 'scheduler',
        tier: 'read',
        requires: ['SYNO.Core.TaskScheduler'],
        handler: async (_args, { client, signal }) => {
            const data = await client.call('SYNO.Core.TaskScheduler', 'list', { offset: 0, limit: -1 }, { version: 1, signal });
            return {
                total: data.total,
                tasks: asList(data.tasks).map((t) => ({
                    id: t.id,
                    name: t.name,
                    type: t.type,
                    owner: t.owner,
                    enabled: t.enable,
                    next_run: t.next_trigger_time,
                    can_run: t.can_run,
                })),
            };
        },
    }),
    tool({
        name: 'scheduler_run',
        title: 'Run a scheduled task now',
        description: 'Run a scheduled task now, by id from scheduler_tasks. It runs whatever script it holds, possibly as root: check what it does first.',
        module: 'scheduler',
        tier: 'write',
        destructive: true,
        requires: ['SYNO.Core.TaskScheduler'],
        input: { task_id: z.number().int() },
        handler: async ({ task_id }, { client, signal }) => {
            await client.call('SYNO.Core.TaskScheduler', 'run', { taskId: task_id }, { version: 1, signal });
            return { task_id, triggered: true };
        },
    }),
];
