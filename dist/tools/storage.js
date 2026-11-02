/** Storage Manager: pools, volumes, disks and S.M.A.R.T., schedules, snapshots, iSCSI. Admin accounts only on DSM's side. */
import { z } from 'zod';
import { DsmError } from '../dsm/errors.js';
import { q } from '../dsm/client.js';
import { asList, bytes, percent } from '../mcp/format.js';
import { tool } from '../mcp/registry.js';
const STORAGE = 'SYNO.Storage.CGI.Storage';
const SMART = 'SYNO.Storage.CGI.Smart';
const HEALTHY = new Set(['normal', 'not_use', 'not_use_disk', 'initialized', 'background', '']);
function isHealthy(status) {
    return status === undefined || status === null || HEALTHY.has(String(status));
}
/** Reduce load_info, Storage Manager's own single source, to what matters and what's wrong. */
export function summarizeStorage(data) {
    const attention = [];
    const volumes = asList(data.volumes).map((v) => {
        const total = v.size?.total;
        const used = v.size?.used;
        const usedPct = percent(used, total);
        const name = v.vol_path ?? v.id;
        if (!isHealthy(v.status))
            attention.push(`Volume ${name} status is "${v.status}".`);
        if (usedPct !== undefined && usedPct >= 90)
            attention.push(`Volume ${name} is ${usedPct}% full.`);
        return {
            id: v.id,
            path: v.vol_path,
            status: v.status,
            fs: v.fs_type,
            raid: v.raidType,
            total: bytes(total),
            used: bytes(used),
            free: total !== undefined && used !== undefined ? bytes(Number(total) - Number(used)) : undefined,
            used_pct: usedPct,
            pool: v.pool_path,
            encrypted: v.is_encrypted,
        };
    });
    const pools = asList(data.storagePools).map((p) => {
        if (!isHealthy(p.status))
            attention.push(`Storage pool ${p.id} status is "${p.status}".`);
        return {
            id: p.id,
            status: p.status,
            raid: p.device_type ?? p.raidType,
            size: bytes(p.size?.total),
            disks: asList(p.disks),
            scrubbing: p.data_scrubbing?.data_scrubbing_status ?? p.scrubbingStatus,
            last_scrub: p.data_scrubbing?.data_scrubbing_finish_time,
        };
    });
    const disks = asList(data.disks).map((d) => {
        const status = d.overview_status ?? d.status;
        const label = d.name ?? d.id;
        if (!isHealthy(status))
            attention.push(`Disk ${label} status is "${status}".`);
        if (!isHealthy(d.smart_status))
            attention.push(`Disk ${label} S.M.A.R.T. status is "${d.smart_status}".`);
        if (Number(d.temp) >= 60)
            attention.push(`Disk ${label} is at ${d.temp}°C.`);
        if (Number(d.unc) > 0)
            attention.push(`Disk ${label} has ${d.unc} uncorrectable sectors.`);
        const life = typeof d.remain_life === 'object' ? d.remain_life?.value : d.remain_life;
        if (typeof life === 'number' && life >= 0 && life <= 10)
            attention.push(`Disk ${label} has ${life}% life left.`);
        return {
            id: d.id,
            name: d.name,
            device: d.device,
            model: String(d.model ?? '').trim(),
            vendor: String(d.vendor ?? '').trim(),
            type: d.diskType,
            ssd: d.isSsd,
            size: bytes(d.size_total),
            status,
            smart: d.smart_status,
            temp_c: d.temp,
            life_pct: typeof life === 'number' && life >= 0 ? life : undefined,
            used_by: d.used_by,
        };
    });
    const caches = asList(data.ssdCaches).map((c) => {
        if (!isHealthy(c.status))
            attention.push(`SSD cache ${c.id} status is "${c.status}".`);
        return { id: c.id, status: c.status, mode: c.mode, size: bytes(c.size?.total), volume: c.mountSpaceId };
    });
    return { volumes, pools, disks, caches, attention };
}
export async function loadStorage(client, signal) {
    return client.call(STORAGE, 'load_info', {}, { version: 1, signal });
}
function disksOf(data) {
    return asList(data.disks);
}
function findDisk(data, wanted) {
    const needle = wanted.replace(/^\/dev\//, '').toLowerCase();
    const match = disksOf(data).find((d) => [d.id, d.device, d.name].some((value) => String(value ?? '').replace(/^\/dev\//, '').toLowerCase() === needle));
    if (!match) {
        const known = disksOf(data).map((d) => d.id).join(', ') || 'none';
        throw new DsmError(`No disk "${wanted}" on this NAS. Known disks: ${known}.`, { kind: 'not_found' });
    }
    return match;
}
export const storageTools = [
    tool({
        name: 'storage_overview',
        title: 'Storage overview',
        description: 'Volumes (free space, RAID, status), storage pools, disks (health, temperature, life) and SSD caches, plus an `attention` list of anything wrong. Start here for any question about disks, RAID or free space.',
        module: 'storage',
        tier: 'read',
        requires: [STORAGE],
        handler: async (_args, { client, signal }) => {
            const summary = summarizeStorage(await loadStorage(client, signal));
            const scrubbing = await client.tryCall('SYNO.Storage.CGI.Check', 'is_data_scrubbing', {}, { version: 1, signal });
            return { ...summary, scrubbing_now: scrubbing.ok ? scrubbing.data : undefined };
        },
    }),
    tool({
        name: 'storage_disk',
        title: 'Disk detail',
        description: 'One disk in full: identity, health summary and every S.M.A.R.T. attribute. `disk` is an id from storage_overview, e.g. sda or sata1.',
        module: 'storage',
        tier: 'read',
        requires: [STORAGE, SMART],
        input: { disk: z.string().describe('Disk id, e.g. sda or sata1') },
        handler: async ({ disk }, { client, signal }) => {
            const found = findDisk(await loadStorage(client, signal), disk);
            const device = String(found.device ?? `/dev/${found.id}`);
            const [health, smart] = await Promise.all([
                client.tryCall(SMART, 'get_health_info', { device }, { version: 1, signal }),
                client.tryCall(SMART, 'get_smart_info', { device }, { version: 1, signal }),
            ]);
            return {
                id: found.id,
                name: found.name,
                device,
                model: String(found.model ?? '').trim(),
                serial: found.serial,
                firmware: found.firm,
                size: bytes(found.size_total),
                status: found.overview_status ?? found.status,
                smart_status: found.smart_status,
                temp_c: found.temp,
                health: health.ok ? health.data : { unavailable: health.error.message },
                smart: smart.ok ? smart.data : { unavailable: smart.error.message },
            };
        },
    }),
    tool({
        name: 'storage_volume_usage',
        title: 'Volume space usage',
        description: 'Space used on a volume by category. `volume` is a path like /volume1.',
        module: 'storage',
        tier: 'read',
        requires: ['SYNO.Storage.CGI.Volume'],
        input: { volume: z.string().describe('Volume path, e.g. /volume1') },
        handler: async ({ volume }, { client, signal }) => client.call('SYNO.Storage.CGI.Volume', 'get_space_usage', { volume_path: volume }, { version: 1, signal }),
    }),
    tool({
        name: 'storage_schedules',
        title: 'Storage schedules',
        description: 'Data scrubbing plan, S.M.A.R.T. test schedule and scheduled storage tasks.',
        module: 'storage',
        tier: 'read',
        requires: [STORAGE],
        handler: async (_args, { client, signal }) => {
            const [scrub, smart, tasks] = await Promise.all([
                client.tryCall(STORAGE, 'get_schedule_plan', {}, { version: 1, signal }),
                client.tryCall('SYNO.Storage.CGI.Smart.Scheduler', 'list', {}, { version: 1, signal }),
                client.tryCall(STORAGE, 'get_sche_task_list', {}, { version: 1, signal }),
            ]);
            const view = (r) => (r.ok ? r.data : { unavailable: r.error.message });
            return { data_scrubbing: view(scrub), smart_tests: view(smart), scheduled_tasks: view(tasks) };
        },
    }),
    tool({
        name: 'storage_snapshots',
        title: 'Share snapshots',
        description: 'Snapshots of a shared folder, newest first. Needs the Snapshot Replication package.',
        module: 'storage',
        tier: 'read',
        requires: ['SYNO.Core.Share.Snapshot'],
        input: {
            share: z.string().describe('Shared folder name'),
            limit: z.number().int().min(1).max(500).default(50),
        },
        handler: async ({ share, limit }, { client, signal }) => {
            // v1 of this API answers an empty list even when snapshots exist; only v2 lists them.
            const data = await client.call('SYNO.Core.Share.Snapshot', 'list', { name: q(share), additional: ['desc', 'lock', 'schedule_snapshot'], offset: 0, limit: -1 }, { version: 2, exactVersion: true, signal });
            const snapshots = asList(data.snapshots)
                .map((s) => (typeof s === 'string' ? { time: s } : { time: s.time, description: s.desc, locked: s.lock, scheduled: s.schedule_snapshot }))
                .sort((a, b) => String(b.time).localeCompare(String(a.time)));
            return { share, total: data.total ?? snapshots.length, snapshots: snapshots.slice(0, limit) };
        },
    }),
    tool({
        name: 'iscsi_list',
        title: 'iSCSI LUNs and targets',
        description: 'iSCSI LUNs (size, type, status) and targets (IQN, mapped LUNs). DSM reports LUN mappings only on the target side.',
        module: 'storage',
        tier: 'read',
        requires: ['SYNO.Core.ISCSI.LUN'],
        handler: async (_args, { client, signal }) => {
            const [luns, targets] = await Promise.all([
                client.tryCall('SYNO.Core.ISCSI.LUN', 'list', {}, { version: 1, signal }),
                client.tryCall('SYNO.Core.ISCSI.Target', 'list', {}, { version: 1, signal }),
            ]);
            return {
                luns: luns.ok
                    ? asList(luns.data.luns).map((l) => ({
                        name: l.name,
                        uuid: l.uuid,
                        type: l.type,
                        size: bytes(l.size),
                        location: l.location,
                        status: l.status,
                    }))
                    : { unavailable: luns.error.message },
                targets: targets.ok
                    ? asList(targets.data.targets).map((t) => ({
                        id: t.target_id,
                        name: t.name,
                        iqn: t.iqn,
                        auth: t.auth_type,
                        luns: t.mapped_luns ?? t.mapped_lun,
                    }))
                    : { unavailable: targets.error.message },
            };
        },
    }),
];
