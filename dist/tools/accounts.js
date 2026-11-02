/** Users, groups, shared folders and their permissions. Writes need the admin tier. */
import { z } from 'zod';
import { q } from '../dsm/client.js';
import { DsmError } from '../dsm/errors.js';
import { asList, bytes } from '../mcp/format.js';
import { confirmationNeeded, tool } from '../mcp/registry.js';
const USER = 'SYNO.Core.User';
const GROUP = 'SYNO.Core.Group';
const MEMBER = 'SYNO.Core.Group.Member';
const USERGROUP = 'SYNO.Core.User.Group';
const SHARE = 'SYNO.Core.Share';
const PERMISSION = 'SYNO.Core.Share.Permission';
const NFS = 'SYNO.Core.FileServ.NFS.SharePrivilege';
/**
 * DSM parses JSON-format values as JSON first, so a password like `123456` or `true` would reach
 * it as a number or boolean and be stored as something other than what was asked.
 */
function assertLiteralPassword(password) {
    let parsed;
    try {
        parsed = JSON.parse(password);
    }
    catch {
        return;
    }
    if (typeof parsed !== 'string') {
        throw new DsmError('This password would be misread by DSM as a JSON value (a bare number, true, false, null, or a list).', {
            kind: 'invalid_parameter',
            hint: 'Use a password that also contains letters or symbols.',
        });
    }
}
export const accountTools = [
    tool({
        name: 'users_list',
        title: 'List users',
        description: 'Local DSM accounts with description, email, status and 2FA. With name: that user with their groups and shared folder permissions.',
        module: 'accounts',
        tier: 'read',
        requires: [USER],
        input: { name: z.string().optional() },
        handler: async ({ name }, { client, signal }) => {
            if (name) {
                const [user, groups, permissions] = await Promise.all([
                    client.call(USER, 'get', { name }, { version: 1, signal }),
                    client.tryCall(USERGROUP, 'list', { name }, { version: 1, signal }),
                    client.tryCall(PERMISSION, 'list_by_user', { name, user_group_type: 'local_user' }, { version: 1, signal }),
                ]);
                const detail = asList(user.users)[0] ?? user;
                return {
                    name: detail.name,
                    description: detail.description,
                    email: detail.email,
                    expired: detail.expired,
                    cannot_change_password: detail.cannot_chg_passwd,
                    groups: groups.ok ? asList(groups.data.groups).map((g) => g.name ?? g) : undefined,
                    shares: permissions.ok
                        ? asList(permissions.data.shares).map((s) => ({
                            share: s.name,
                            access: s.is_deny ? 'deny' : s.is_writable ? 'read-write' : s.is_readonly ? 'read-only' : 'none',
                        }))
                        : undefined,
                };
            }
            const data = await client.call(USER, 'list', { offset: 0, limit: -1, type: 'local', additional: ['description', 'email', 'expired', '2fa_status'] }, { version: 1, signal });
            return {
                total: data.total,
                users: asList(data.users).map((u) => ({
                    name: u.name,
                    description: u.description,
                    email: u.email,
                    status: u.expired,
                    two_factor: u['2fa_status'],
                })),
            };
        },
    }),
    tool({
        name: 'groups_list',
        title: 'List groups',
        description: 'Local groups. With name: the user accounts in that group. System accounts, such as service users, are not listed by DSM.',
        module: 'accounts',
        tier: 'read',
        requires: [GROUP],
        input: { name: z.string().optional() },
        handler: async ({ name }, { client, signal }) => {
            if (name) {
                const data = await client.call(MEMBER, 'list', { group: name, ingroup: true }, { version: 1, signal });
                const members = asList(data.users ?? data.members ?? data);
                return { group: name, members: members.map((m) => m.name ?? m) };
            }
            const data = await client.call(GROUP, 'list', { offset: 0, limit: -1, type: 'local' }, { version: 1, signal });
            return { total: data.total, groups: asList(data.groups).map((g) => ({ name: g.name, description: g.description })) };
        },
    }),
    tool({
        name: 'user_create',
        title: 'Create a user',
        description: 'Create a local DSM account. The password passes through this conversation: prefer a temporary one the user changes afterwards.',
        module: 'accounts',
        tier: 'admin',
        destructive: false,
        requires: [USER],
        input: {
            name: z.string(),
            password: z.string().min(1),
            description: z.string().default(''),
            email: z.string().default(''),
            cannot_change_password: z.boolean().default(false),
            password_never_expires: z.boolean().default(true),
        },
        handler: async ({ name, password, description, email, cannot_change_password, password_never_expires }, { client, signal }) => {
            assertLiteralPassword(password);
            await client.call(USER, 'create', {
                name,
                password,
                description,
                email,
                expired: 'normal',
                cannot_chg_passwd: cannot_change_password,
                passwd_never_expire: password_never_expires,
                notify_by_email: false,
                send_password: false,
            }, { version: 1, signal });
            return { created: name };
        },
    }),
    tool({
        name: 'user_update',
        title: 'Update a user',
        description: 'Change a user: rename, set a password, description or email, or enable or disable the account. Disabling yourself locks this server out.',
        module: 'accounts',
        tier: 'admin',
        destructive: true,
        requires: [USER],
        input: {
            name: z.string(),
            new_name: z.string().optional(),
            password: z.string().min(1).optional(),
            description: z.string().optional(),
            email: z.string().optional(),
            enabled: z.boolean().optional(),
        },
        handler: async ({ name, new_name, password, description, email, enabled }, { client, config, signal }) => {
            if (password)
                assertLiteralPassword(password);
            if (enabled === false && name === config.username) {
                throw new DsmError('That is the account this server logs in with; disabling it would lock the server out.', { kind: 'refused' });
            }
            await client.call(USER, 'set', {
                name,
                new_name,
                password,
                description,
                email,
                expired: enabled === undefined ? undefined : enabled ? 'normal' : 'now',
            }, { version: 1, signal });
            const changes = { new_name, password, description, email, enabled };
            return { updated: name, changed: Object.entries(changes).filter(([, value]) => value !== undefined).map(([key]) => key) };
        },
    }),
    tool({
        name: 'user_delete',
        title: 'Delete a user',
        description: 'Delete a local DSM account. The first call previews; confirm=true deletes.',
        module: 'accounts',
        tier: 'admin',
        requires: [USER],
        input: {
            name: z.string(),
            confirm: z.boolean().default(false),
        },
        handler: async ({ name, confirm }, { client, config, signal }) => {
            if (name === config.username) {
                throw new DsmError('That is the account this server logs in with.', { kind: 'refused' });
            }
            if (!confirm) {
                await client.call(USER, 'get', { name }, { version: 1, signal });
                return confirmationNeeded({ would_delete_user: name });
            }
            await client.call(USER, 'delete', { name }, { version: 1, signal });
            return { deleted: name };
        },
    }),
    tool({
        name: 'user_groups_set',
        title: 'Change group membership',
        description: 'Add a user to or remove them from groups. DSM applies this in the background, so the reply says whether it is visible yet. Adding to "administrators" grants full control of the NAS.',
        module: 'accounts',
        tier: 'admin',
        destructive: true,
        requires: [USERGROUP],
        input: {
            name: z.string(),
            join: z.array(z.string()).default([]),
            leave: z.array(z.string()).default([]),
        },
        handler: async ({ name, join, leave }, { client, signal }) => {
            if (!join.length && !leave.length)
                throw new DsmError('Name at least one group to join or leave.', { kind: 'invalid_parameter' });
            await client.call(USERGROUP, 'join', { name, join_groups: join.length ? join : undefined, leave_groups: leave.length ? leave : undefined }, { version: 1, signal });
            const pending = [];
            for (const [groups, wanted] of [
                [join, true],
                [leave, false],
            ]) {
                for (const group of groups) {
                    let visible = false;
                    for (let attempt = 0; attempt < 5 && !visible; attempt += 1) {
                        if (attempt)
                            await new Promise((resolve) => setTimeout(resolve, 600));
                        const data = await client.tryCall(MEMBER, 'list', { group, ingroup: true }, { version: 1, signal });
                        if (data.ok) {
                            const members = asList(data.data.users ?? data.data.members ?? data.data).map((m) => m.name ?? m);
                            visible = members.includes(name) === wanted;
                        }
                    }
                    if (!visible)
                        pending.push(group);
                }
            }
            return {
                user: name,
                joined: join,
                left: leave,
                verified: pending.length === 0,
                not_yet_visible: pending.length ? pending : undefined,
                note: pending.length ? 'DSM accepted the change but it is not visible yet. Treat it as queued and check groups_list again.' : undefined,
            };
        },
    }),
    tool({
        name: 'user_share_permission_set',
        title: 'Set shared folder permissions',
        description: 'Set a user\'s access to shared folders: read-write, read-only, deny or none.',
        module: 'accounts',
        tier: 'admin',
        destructive: true,
        requires: [PERMISSION],
        input: {
            name: z.string(),
            permissions: z
                .array(z.object({ share: z.string(), access: z.enum(['read-write', 'read-only', 'deny', 'none']) }))
                .min(1),
        },
        handler: async ({ name, permissions }, { client, signal }) => {
            await client.call(PERMISSION, 'set_by_user_group', {
                name,
                user_group_type: 'local_user',
                permissions: permissions.map((p) => ({
                    name: p.share,
                    is_writable: p.access === 'read-write',
                    is_readonly: p.access === 'read-only',
                    is_deny: p.access === 'deny',
                })),
            }, { version: 1, signal });
            return { user: name, applied: permissions };
        },
    }),
    tool({
        name: 'shares_list',
        title: 'List shared folders (admin view)',
        description: 'All shared folders with volume, description, recycle bin, encryption and snapshot count. For browsing use files_shares.',
        module: 'accounts',
        tier: 'read',
        requires: [SHARE],
        handler: async (_args, { client, signal }) => {
            const data = await client.call(SHARE, 'list', { shareType: 'all', additional: ['hidden', 'encryption', 'is_aclmode', 'recyclebin', 'vol_path', 'share_quota', 'enable_snapshot', 'snapshot_count'] }, { version: 1, signal });
            return {
                total: data.total,
                shares: asList(data.shares).map((s) => ({
                    name: s.name,
                    volume: s.vol_path,
                    description: s.desc,
                    recycle_bin: s.enable_recycle_bin,
                    recycle_admin_only: s.recycle_bin_admin_only,
                    encrypted: Boolean(s.encryption) || undefined,
                    hidden: s.hidden || undefined,
                    quota: s.quota_value ? bytes(Number(s.quota_value) * 1024 * 1024) : undefined,
                    snapshots: s.snapshot_info?.snapshot_count,
                    usb: s.is_usb_share || undefined,
                })),
            };
        },
    }),
    tool({
        name: 'share_create',
        title: 'Create a shared folder',
        description: 'Create a shared folder on a volume, with its recycle bin on by default.',
        module: 'accounts',
        tier: 'admin',
        destructive: false,
        requires: [SHARE],
        input: {
            name: z.string(),
            volume: z.string().default('/volume1'),
            description: z.string().default(''),
            recycle_bin: z.boolean().default(true),
            recycle_admin_only: z.boolean().default(true),
        },
        handler: async ({ name, volume, description, recycle_bin, recycle_admin_only }, { client, signal }) => {
            // DSM 7.3.2 refuses flat parameters here with 403: it wants this envelope, as its web UI sends.
            await client.call(SHARE, 'create', {
                name: q(name),
                shareinfo: {
                    name,
                    vol_path: volume,
                    desc: description,
                    enable_recycle_bin: recycle_bin,
                    recycle_bin_admin_only: recycle_admin_only,
                    enable_share_cow: false,
                    enable_share_compress: false,
                    name_org: '',
                },
            }, { version: 1, signal, timeoutMs: 60_000 });
            return { created: name, volume };
        },
    }),
    tool({
        name: 'share_delete',
        title: 'Delete a shared folder',
        description: 'Delete a shared folder AND EVERYTHING IN IT, permanently: its recycle bin goes too. The first call previews with the size. To go ahead, pass confirm_name equal to the share name.',
        module: 'accounts',
        tier: 'admin',
        requires: [SHARE],
        input: {
            name: z.string(),
            confirm_name: z.string().optional().describe('Must equal name to delete'),
        },
        handler: async ({ name, confirm_name }, { client, signal }) => {
            if (confirm_name !== name) {
                const shares = await client.call(SHARE, 'list', { shareType: 'all', additional: ['vol_path'] }, { version: 1, signal });
                const match = asList(shares.shares).find((s) => s.name === name);
                if (!match)
                    throw new DsmError(`No shared folder named "${name}".`, { kind: 'not_found' });
                return confirmationNeeded({
                    would_delete_share: name,
                    volume: match.vol_path,
                    warning: 'Everything in it is deleted permanently. This cannot be undone. Check its size with files_dir_size first.',
                    next_step: `Show this to the user. If they agree, call again with confirm_name="${name}".`,
                });
            }
            await client.call(SHARE, 'delete', { name }, { version: 1, signal, timeoutMs: 120_000 });
            return { deleted: name };
        },
    }),
    tool({
        name: 'share_nfs_rules',
        title: 'NFS rules of a share',
        description: 'The NFS client rules of a shared folder.',
        module: 'accounts',
        tier: 'read',
        requires: [NFS],
        input: { share: z.string() },
        handler: async ({ share }, { client, signal }) => {
            const data = await client.call(NFS, 'load', { share_name: share }, { version: 1, signal });
            return { share, rules: asList(data.rule) };
        },
    }),
    tool({
        name: 'share_nfs_rule_set',
        title: 'Set an NFS rule',
        description: 'Add or replace one NFS client rule on a shared folder, keeping the others. `client` is an IP or subnet. no_root_squash gives that client root on the share.',
        module: 'accounts',
        tier: 'admin',
        destructive: true,
        requires: [NFS],
        input: {
            share: z.string(),
            client: z.string().describe('e.g. 192.168.1.0/24'),
            privilege: z.enum(['readonly', 'readwrite']).default('readwrite'),
            squash: z.enum(['root_squash', 'no_root_squash', 'all_squash']).default('root_squash'),
            security: z.enum(['sys', 'krb5', 'krb5i', 'krb5p']).default('sys'),
        },
        handler: async ({ share, client: nfsClient, privilege, squash, security }, { client, signal }) => {
            const current = await client.call(NFS, 'load', { share_name: share }, { version: 1, signal });
            if (!Array.isArray(current.rule)) {
                throw new DsmError('DSM returned NFS rules in an unexpected shape, so nothing was changed.', { kind: 'bad_reply', api: NFS, method: 'load' });
            }
            const flavor = { krb5: 'kerberos', krb5i: 'kerberos_integrity', krb5p: 'kerberos_privacy', sys: 'sys' }[security];
            const rule = {
                client: nfsClient,
                privilege: privilege === 'readonly' ? 'ro' : 'rw',
                root_squash: { no_root_squash: 'root', root_squash: 'guest', all_squash: 'all_guest' }[squash],
                async: true,
                insecure: false,
                crossmnt: false,
                security_flavor: { sys: flavor === 'sys', kerberos: flavor === 'kerberos', kerberos_integrity: flavor === 'kerberos_integrity', kerberos_privacy: flavor === 'kerberos_privacy' },
            };
            const rules = [...current.rule.filter((r) => r.client !== nfsClient), rule];
            await client.call(NFS, 'save', { share_name: share, rule: rules }, { version: 1, signal });
            return { share, saved: rule, total_rules: rules.length };
        },
    }),
];
