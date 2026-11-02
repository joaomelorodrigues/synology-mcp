/** System: the one-call overview, capabilities, load, processes, logs, hardware, updates, power. */

import { z } from 'zod';
import { DsmError } from '../dsm/errors.js';
import { asList, bytes, duration } from '../mcp/format.js';
import { confirmationNeeded, tool, type ToolContext, type ToolDef } from '../mcp/registry.js';
import { loadStorage, summarizeStorage } from './storage.js';

const INFO = 'SYNO.DSM.Info';
const UTIL = 'SYNO.Core.System.Utilization';
const LOG = 'SYNO.Core.SyslogClient.Log';

function summarizeLoad(data: any): Record<string, unknown> {
  const cpu = data.cpu ?? {};
  const mem = data.memory ?? {};
  const totalKb = Number(mem.total_real ?? 0);
  const availKb = Number(mem.avail_real ?? 0);
  const nets = asList<any>(data.network);
  const net = nets.find((n) => n.device === 'total') ?? nets[0] ?? {};
  return {
    cpu_pct: Number(cpu.user_load ?? 0) + Number(cpu.system_load ?? 0) + Number(cpu.other_load ?? 0),
    load_avg: [cpu['1min_load'], cpu['5min_load'], cpu['15min_load']],
    mem_pct: mem.real_usage,
    mem_used: totalKb ? bytes((totalKb - availKb) * 1024) : undefined,
    mem_total: totalKb ? bytes(totalKb * 1024) : undefined,
    swap_pct: mem.swap_usage,
    net_rx_per_s: bytes(net.rx),
    net_tx_per_s: bytes(net.tx),
  };
}

function summarizeInfo(info: any, hostname?: string): Record<string, unknown> {
  return {
    hostname,
    model: info.model,
    dsm: info.version_string,
    serial: info.serial,
    ram: info.ram ? `${info.ram} MiB` : undefined,
    uptime: duration(info.uptime),
    temp_c: info.temperature,
    temp_warning: info.temperature_warn,
    time: info.time,
  };
}

async function isAdminAccount(context: Pick<ToolContext, 'client' | 'signal'>): Promise<boolean | undefined> {
  const probe = await context.client.tryCall(UTIL, 'get', {}, { version: 1, signal: context.signal });
  if (probe.ok) return true;
  return probe.error.kind === 'permission_denied' ? false : undefined;
}

export const systemTools: ToolDef[] = [
  tool({
    name: 'nas_overview',
    title: 'NAS overview',
    description:
      'One-call health snapshot: identity, load, volumes, pools, disks, containers, pending reboot and DSM update, with an `attention` list of anything wrong. Start here for "how is my NAS?" or to build a dashboard.',
    module: 'system',
    tier: 'read',
    requires: [INFO],
    handler: async (_args, { client, signal }) => {
      const options = { signal, timeoutMs: 15_000 };
      const [info, network, load, health, reboot, storage, containers, update] = await Promise.all([
        client.tryCall(INFO, 'getinfo', {}, { version: 2, ...options }),
        client.tryCall('SYNO.Core.Network', 'get', {}, { version: 1, ...options }),
        client.tryCall(UTIL, 'get', {}, { version: 1, ...options }),
        client.tryCall('SYNO.Core.System.SystemHealth', 'get', {}, { version: 1, ...options }),
        client.tryCall('SYNO.Core.Hardware.NeedReboot', 'get', {}, { version: 1, ...options }),
        loadStorage(client, signal).then(
          (data) => ({ ok: true as const, data }),
          (error) => ({ ok: false as const, error: client.toDsmError(error) }),
        ),
        client.tryCall('SYNO.Docker.Container', 'list', { offset: 0, limit: -1, type: 'all' }, { version: 1, ...options }),
        client.tryCall('SYNO.Core.Upgrade.Server', 'check', {}, { version: 2, ...options }),
      ]);

      const unavailable: Record<string, string> = {};
      const note = (name: string, result: { ok: boolean; error?: DsmError }): void => {
        if (!result.ok && result.error && result.error.kind !== 'api_not_found') unavailable[name] = result.error.message;
      };
      note('info', info);
      note('load', load);
      note('storage', storage);
      note('containers', containers);
      note('update', update);

      const attention: string[] = [];
      const summary = storage.ok ? summarizeStorage(storage.data) : undefined;
      if (summary) attention.push(...summary.attention);
      if (info.ok && info.data.temperature_warn) attention.push(`System temperature warning (${info.data.temperature}°C).`);
      if (reboot.ok && reboot.data.needReboot) attention.push('DSM is asking for a reboot.');

      let containerView: Record<string, unknown> | undefined;
      if (containers.ok) {
        const items = asList<any>(containers.data.containers);
        const running = items.filter((c) => c.status === 'running' || c.state?.Running);
        const unhealthy = items.filter((c) => c.state?.Health?.Status === 'unhealthy' || c.health === 'unhealthy').map((c) => c.name);
        const crashed = items.filter((c) => Number(c.state?.ExitCode ?? 0) !== 0 && c.status !== 'running').map((c) => c.name);
        for (const name of unhealthy) attention.push(`Container ${name} is unhealthy.`);
        for (const name of crashed) attention.push(`Container ${name} exited with an error.`);
        containerView = { total: items.length, running: running.length, unhealthy, crashed };
      }

      let updateView: Record<string, unknown> | undefined;
      if (update.ok) {
        const available = Boolean(update.data.update?.available);
        if (available) attention.push(`DSM update available: ${update.data.update?.version_string ?? update.data.update?.version}.`);
        updateView = { available, version: update.data.update?.version_string };
      }

      const healthParams = health.ok ? health.data?.rule?.description?.description_params : undefined;
      return {
        nas: info.ok ? summarizeInfo(info.data, network.ok ? network.data.server_name : undefined) : undefined,
        health: Array.isArray(healthParams) ? String(healthParams[0]).replace('widget:', '') : undefined,
        attention,
        load: load.ok ? summarizeLoad(load.data) : undefined,
        volumes: summary?.volumes,
        pools: summary?.pools,
        disks: summary?.disks,
        containers: containerView,
        dsm_update: updateView,
        reboot_required: reboot.ok ? Boolean(reboot.data.needReboot) : undefined,
        unavailable: Object.keys(unavailable).length ? unavailable : undefined,
      };
    },
  }),

  tool({
    name: 'nas_capabilities',
    title: 'What this connection can do',
    description:
      'Which tools this connection has and which are hidden and why (permission tier, disabled module, or package missing on the NAS), the account, and how to enable more. Use before telling the user something is impossible.',
    module: 'system',
    tier: 'read',
    handler: async (_args, context) => {
      const { client, config, selection, credentials } = context;
      const catalog = await client.catalog().catch(() => undefined);
      const sources = await credentials.sources();
      const admin = await isAdminAccount(context).catch(() => undefined);
      const hiddenByReason: Record<string, string[]> = {};
      for (const hidden of selection.hidden) (hiddenByReason[hidden.reason] ??= []).push(hidden.name);
      const modules: Record<string, number> = {};
      for (const def of selection.active) modules[def.module] = (modules[def.module] ?? 0) + 1;
      return {
        nas_url: config.url,
        account: config.username,
        account_is_admin: admin,
        two_factor: sources.deviceId === 'missing' ? 'no trusted-device token stored' : 'trusted-device token stored',
        tier: config.tier,
        power_tools: config.allowPower,
        active_tools: selection.active.length,
        active_by_module: modules,
        hidden: hiddenByReason,
        hidden_detail: selection.hidden.filter((h) => h.reason === 'package').map((h) => `${h.name}: ${h.detail}`),
        dsm_apis_on_nas: catalog?.size,
        any_other_api: 'dsm_api_search finds any DSM API on this NAS; dsm_read and dsm_write call it.',
        how_to_change: `Edit ${config.configPath} (tier: read|write|admin, allowPower, modules), then restart the MCP server.`,
      };
    },
  }),

  tool({
    name: 'nas_auth_otp',
    title: 'Renew 2FA trust with a code',
    description:
      'Log in with a current 2FA code and store a new trusted-device token. Use only after a login error says the token is missing or refused: ask the user for the 6-digit code from their authenticator app.',
    module: 'system',
    tier: 'read',
    idempotent: false,
    input: { code: z.string().regex(/^\d{6,8}$/).describe('Current 2FA code') },
    handler: async ({ code }, { client, credentials }) => {
      const { deviceToken } = await client.login({ otpCode: code, requestDeviceToken: true });
      if (!deviceToken) {
        return { logged_in: true, device_token_saved: false, note: 'DSM accepted the code but returned no device token, so another code will be needed after this session ends.' };
      }
      await credentials.saveDeviceId(deviceToken);
      return {
        logged_in: true,
        device_token_saved: true,
        stored_in: credentials.storeName,
        warning: credentials.envOverridesDeviceId
          ? 'SYNOLOGY_DEVICE_ID is set in the environment and overrides the stored token. Remove it from the client config.'
          : undefined,
      };
    },
  }),

  tool({
    name: 'system_info',
    title: 'System information',
    description: 'Model, serial, DSM version, CPU, RAM, uptime, temperature, time zone and NTP. Hardware detail needs an admin account.',
    module: 'system',
    tier: 'read',
    requires: [INFO],
    handler: async (_args, { client, signal }) => {
      const [info, core, network, ntp] = await Promise.all([
        client.call(INFO, 'getinfo', {}, { version: 2, signal }),
        client.tryCall('SYNO.Core.System', 'info', {}, { version: 1, signal }),
        client.tryCall('SYNO.Core.Network', 'get', {}, { version: 1, signal }),
        client.tryCall('SYNO.Core.Region.NTP', 'get', {}, { version: 1, signal }),
      ]);
      const c: any = core.ok ? core.data : {};
      return {
        ...summarizeInfo(info, network.ok ? network.data.server_name : undefined),
        cpu: c.cpu_series ? `${c.cpu_vendor ?? ''} ${c.cpu_family ?? ''} ${c.cpu_series}`.trim() : undefined,
        cpu_cores: c.cpu_cores,
        cpu_mhz: c.cpu_clock_speed,
        firmware_date: c.firmware_date,
        usb_devices: c.usb_dev,
        sata_devices: c.sata_dev,
        time_zone: ntp.ok ? ntp.data.timezone : c.time_zone,
        ntp_enabled: ntp.ok ? Boolean(ntp.data.enable_ntp) : undefined,
        ntp_server: ntp.ok ? ntp.data.server : c.ntp_server,
        admin_detail: core.ok ? undefined : `unavailable: ${core.error.message}`,
      };
    },
  }),

  tool({
    name: 'system_load',
    title: 'Live load',
    description: 'Live CPU, memory, swap, network throughput per interface and I/O per disk. Needs an admin account.',
    module: 'system',
    tier: 'read',
    requires: [UTIL],
    handler: async (_args, { client, signal }) => {
      const data = await client.call(UTIL, 'get', {}, { version: 1, signal });
      return {
        ...summarizeLoad(data),
        interfaces: asList<any>(data.network)
          .filter((n) => n.device !== 'total')
          .map((n) => ({ device: n.device, rx_per_s: bytes(n.rx), tx_per_s: bytes(n.tx) })),
        disks: asList<any>(data.disk?.disk).map((d) => ({
          disk: d.display_name ?? d.device,
          busy_pct: d.utilization,
          read_per_s: bytes(d.read_byte),
          write_per_s: bytes(d.write_byte),
        })),
        volumes: asList<any>(data.space?.volume).map((v) => ({
          volume: v.display_name ?? v.device,
          busy_pct: v.utilization,
          read_per_s: bytes(v.read_byte),
          write_per_s: bytes(v.write_byte),
        })),
      };
    },
  }),

  tool({
    name: 'system_processes',
    title: 'Top processes',
    description: 'Running processes sorted by CPU or memory. Needs an admin account.',
    module: 'system',
    tier: 'read',
    requires: ['SYNO.Core.System.Process'],
    input: {
      sort_by: z.enum(['cpu', 'memory']).default('cpu'),
      top: z.number().int().min(1).max(200).default(20),
    },
    handler: async ({ sort_by, top }, { client, signal }) => {
      const data = await client.call('SYNO.Core.System.Process', 'list', {}, { version: 1, signal });
      const key = sort_by === 'cpu' ? 'cpu' : 'mem';
      const processes = asList<any>(data.process ?? data.items).sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
      return {
        total: processes.length,
        processes: processes.slice(0, top).map((p) => ({
          pid: p.pid,
          command: p.command ?? p.name,
          cpu: p.cpu,
          memory: p.mem !== undefined ? bytes(Number(p.mem) * 1024) : undefined,
        })),
      };
    },
  }),

  tool({
    name: 'system_connections',
    title: 'Active connections',
    description: 'Who is connected right now: user, source address, protocol and since when.',
    module: 'system',
    tier: 'read',
    requires: ['SYNO.Core.CurrentConnection'],
    handler: async (_args, { client, signal }) => {
      const data = await client.call('SYNO.Core.CurrentConnection', 'list', {}, { version: 1, signal });
      return {
        total: data.total ?? asList(data.items).length,
        connections: asList<any>(data.items).map((c) => ({
          user: c.who ?? c.descr,
          from: c.from,
          protocol: c.protocol ?? c.type,
          since: c.time,
          this_session: c.is_current_connected,
        })),
      };
    },
  }),

  tool({
    name: 'system_logs',
    title: 'System logs',
    description: 'DSM log entries, newest first, with counts by level. `level` and `keyword` filter the entries read.',
    module: 'system',
    tier: 'read',
    requires: [LOG],
    input: {
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      level: z.enum(['info', 'warning', 'warn', 'error']).optional(),
      keyword: z.string().optional().describe('Case-insensitive text to find in the message or user'),
    },
    handler: async ({ limit, offset, level, keyword }, { client, signal }) => {
      // DSM offers no server-side filter here that the references verify, so widen the page.
      const filtering = Boolean(level || keyword);
      const data = await client.call(LOG, 'list', { offset, limit: filtering ? Math.max(limit * 10, 500) : limit }, { version: 1, signal });
      const wanted = level === 'warning' ? 'warn' : level;
      const needle = keyword?.toLowerCase();
      const entries = asList<any>(data.items)
        .filter((e) => !wanted || String(e.level).toLowerCase().startsWith(wanted))
        .filter((e) => !needle || `${e.descr} ${e.who}`.toLowerCase().includes(needle))
        .slice(0, limit);
      return {
        total: data.total,
        counts: { info: data.infoCount, warning: data.warnCount, error: data.errorCount },
        logs: entries.map((e) => ({ time: e.time, level: e.level, type: e.logtype, who: e.who, message: e.descr })),
      };
    },
  }),

  tool({
    name: 'system_network',
    title: 'Network configuration',
    description: 'Hostname, gateway, DNS and each interface with address, link speed and status.',
    module: 'system',
    tier: 'read',
    requires: ['SYNO.Core.Network'],
    handler: async (_args, { client, signal }) => {
      const [core, interfaces] = await Promise.all([
        client.call('SYNO.Core.Network', 'get', {}, { version: 1, signal }),
        client.tryCall('SYNO.Core.Network.Interface', 'list', {}, { version: 1, signal }),
      ]);
      return {
        hostname: core.server_name,
        gateway: core.gateway,
        dns: [core.dns_primary, core.dns_secondary].filter(Boolean),
        interfaces: interfaces.ok
          ? asList<any>(interfaces.data).map((i) => ({
              name: i.ifname,
              ip: i.ip,
              mask: i.mask,
              type: i.type,
              speed_mbps: i.speed,
              status: i.status,
              dhcp: i.use_dhcp,
            }))
          : { unavailable: interfaces.error.message },
      };
    },
  }),

  tool({
    name: 'system_hardware',
    title: 'Hardware and power',
    description: 'Fans, power recovery and schedule, hibernation, LED and beep settings, UPS and USB devices.',
    module: 'system',
    tier: 'read',
    requiresAny: ['SYNO.Core.Hardware.FanSpeed', 'SYNO.Core.ExternalDevice.UPS'],
    handler: async (_args, { client, signal }) => {
      const get = (api: string, method = 'get') => client.tryCall(api, method, {}, { version: 1, signal });
      const [fan, recovery, schedule, hibernation, led, beep, ups, usb] = await Promise.all([
        get('SYNO.Core.Hardware.FanSpeed'),
        get('SYNO.Core.Hardware.PowerRecovery'),
        get('SYNO.Core.Hardware.PowerSchedule', 'load'),
        get('SYNO.Core.Hardware.Hibernation'),
        get('SYNO.Core.Hardware.Led.Brightness'),
        get('SYNO.Core.Hardware.BeepControl'),
        get('SYNO.Core.ExternalDevice.UPS'),
        get('SYNO.Core.ExternalDevice.Storage.USB', 'list'),
      ]);
      const value = <T>(r: { ok: boolean; data?: any }, pick: (data: any) => T): T | undefined => (r.ok ? pick(r.data) : undefined);
      return {
        fan: value(fan, (d) => ({ status: d.cool_fan, disk_temp_alarm: d.all_disk_temp_fail })),
        power_recovery: value(recovery, (d) => ({ after_outage: d.rc_power_config, wake_on_lan: d.wol })),
        power_schedule: value(schedule, (d) => ({ power_on: asList(d.poweron_tasks).length, power_off: asList(d.poweroff_tasks).length })),
        hibernation: value(hibernation, (d) => ({ idle_minutes: d.internal_hd_idletime, auto_power_off: d.auto_poweroff_enable })),
        led_brightness: value(led, (d) => d.led_brightness),
        beep_on_power_on: value(beep, (d) => d.poweron_beep),
        ups: value(ups, (d) => ({
          enabled: d.enable,
          model: d.model,
          status: d.status,
          charge_pct: d.charge,
          runtime_s: d.runtime,
          connected: d.usb_ups_connect,
        })),
        usb: value(usb, (d) => asList<any>(d.devices).map((u) => ({ id: u.dev_id, title: u.dev_title }))),
      };
    },
  }),

  tool({
    name: 'dsm_update_status',
    title: 'DSM update status',
    description: 'Whether a DSM update is available, the current update state, the auto-update setting and channel.',
    module: 'system',
    tier: 'read',
    requires: ['SYNO.Core.Upgrade.Server'],
    handler: async (_args, { client, signal }) => {
      const [check, status, setting] = await Promise.all([
        client.call('SYNO.Core.Upgrade.Server', 'check', {}, { version: 2, signal }),
        client.tryCall('SYNO.Core.Upgrade', 'status', {}, { version: 1, signal }),
        client.tryCall('SYNO.Core.Upgrade.Setting', 'get', {}, { version: 1, signal }),
      ]);
      return {
        available: Boolean(check.update?.available),
        version: check.update?.version_string ?? check.update?.version,
        state: status.ok ? status.data.status : undefined,
        auto_download: setting.ok ? setting.data.auto_download : undefined,
        channel: setting.ok ? setting.data.upgrade_type : undefined,
      };
    },
  }),

  tool({
    name: 'nas_power',
    title: 'Reboot or shut down the NAS',
    description:
      'Reboot or shut down the NAS. Every client and service on it drops, and a shut-down NAS needs someone physically nearby or Wake-on-LAN to come back. Requires confirm=true.',
    module: 'system',
    tier: 'power',
    requires: ['SYNO.Core.System'],
    input: {
      action: z.enum(['reboot', 'shutdown']),
      confirm: z.boolean().default(false),
    },
    handler: async ({ action, confirm }, { client }) => {
      if (!confirm) {
        return confirmationNeeded({
          would: `${action} the NAS`,
          warning: action === 'shutdown' ? 'The NAS will not come back on its own.' : 'All services and connections drop until it is back.',
        });
      }
      await client.call('SYNO.Core.System', action, {}, { version: 1 });
      return { action, issued: true };
    },
  }),

  tool({
    name: 'dsm_update_install',
    title: 'Install DSM update',
    description: 'Start installing an available DSM update; the NAS reboots when done. Requires confirm=true. Check dsm_update_status first.',
    module: 'system',
    tier: 'power',
    requires: ['SYNO.Core.Upgrade'],
    input: { confirm: z.boolean().default(false) },
    handler: async ({ confirm }, { client, signal }) => {
      const check = await client.call('SYNO.Core.Upgrade.Server', 'check', {}, { version: 2, signal });
      if (!check.update?.available) {
        throw new DsmError('No DSM update is available.', { kind: 'refused' });
      }
      if (!confirm) {
        return confirmationNeeded({
          would: `install DSM ${check.update.version_string ?? check.update.version} and reboot`,
          warning: 'DSM updates cannot be rolled back.',
        });
      }
      await client.call('SYNO.Core.Upgrade', 'start', {}, { version: 1 });
      return { started: true, version: check.update.version_string ?? check.update.version };
    },
  }),
];
