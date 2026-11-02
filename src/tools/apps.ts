/** Synology Photos, Synology Drive, Download Station, Virtual Machine Manager, Surveillance Station. */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { q, type CallOptions, type DsmClient, type Params } from '../dsm/client.js';
import { DsmError } from '../dsm/errors.js';
import { asList, bytes, isoTime, percent } from '../mcp/format.js';
import { normalizeNasPath, resolveLocalPath } from '../mcp/paths.js';
import { confirmationNeeded, tool, type ToolDef } from '../mcp/registry.js';

// ------------------------------------------------------------------ Photos

const space = z
  .enum(['personal', 'shared'])
  .default('personal')
  .describe('personal: your library; shared: Shared Space. IDs belong to one space.');

type Space = 'personal' | 'shared';

const fotoApi = (s: Space, suffix: string): string => `${s === 'shared' ? 'SYNO.FotoTeam' : 'SYNO.Foto'}.${suffix}`;

/** Photos calls JSON-encode every value, as its web client does. */
function foto(client: DsmClient, s: Space, suffix: string, method: string, params: Params, options: CallOptions = {}): Promise<any> {
  return client.call(fotoApi(s, suffix), method, params, { quoteStrings: true, version: 1, ...options });
}

function itemView(item: any): Record<string, unknown> {
  return {
    id: item.id,
    filename: item.filename,
    type: item.type,
    size: bytes(item.filesize),
    taken: isoTime(item.time),
    width: item.additional?.resolution?.width,
    height: item.additional?.resolution?.height,
    folder_id: item.folder_id,
    owner_is_shared: item.owner_user_id === 0 || undefined,
  };
}

const paging = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(50),
};

export const photoTools: ToolDef[] = [
  tool({
    name: 'photos_collections',
    title: 'Photo albums, people, tags and folders',
    description: 'Browse what organizes a Photos library: albums (personal only), people, tags or folders. For folders, parent_id lists a subfolder.',
    module: 'photos',
    tier: 'read',
    requires: ['SYNO.Foto.Browse.Item'],
    input: {
      kind: z.enum(['albums', 'people', 'tags', 'folders']),
      space,
      parent_id: z.number().int().optional().describe('Folder id, for kind=folders'),
      ...paging,
    },
    handler: async ({ kind, space: s, parent_id, offset, limit }, { client, signal }) => {
      if (kind === 'albums') {
        if (s === 'shared') throw new DsmError('Albums exist only in the personal space.', { kind: 'invalid_parameter' });
        const data = await foto(client, s, 'Browse.Album', 'list', { offset, limit, sort_by: 'create_time', sort_direction: 'desc', additional: ['sharing_info'] }, { version: 2, signal });
        return {
          albums: asList<any>(data.list).map((a) => ({
            id: a.id,
            name: a.name,
            items: a.item_count,
            type: a.type,
            shared: a.shared,
            created: isoTime(a.create_time),
          })),
        };
      }
      if (kind === 'people') {
        const data = await foto(client, s, 'Browse.Person', 'list', { offset, limit, show_more: false, show_hidden: false }, { signal });
        return { people: asList<any>(data.list).map((p) => ({ id: p.id, name: p.name, items: p.item_count })) };
      }
      if (kind === 'tags') {
        const data = await foto(client, s, 'Browse.GeneralTag', 'list', { offset, limit }, { signal });
        return { tags: asList<any>(data.list).map((t) => ({ id: t.id, name: t.name, items: t.item_count })) };
      }
      const id = parent_id ?? (await foto(client, s, 'Browse.Folder', 'get', { id: 0 }, { version: 2, signal })).folder?.id;
      const data = await foto(client, s, 'Browse.Folder', 'list', { id, offset, limit, sort_by: 'filename', sort_direction: 'asc' }, { version: 2, signal });
      return { parent_id: id, folders: asList<any>(data.list).map((f) => ({ id: f.id, name: f.name, owner: f.owner_user_id })) };
    },
  }),

  tool({
    name: 'photos_items',
    title: 'List photos',
    description: 'Photos and videos in an album, folder, person or tag, or recent ones when no source is given. Sorted by date taken, newest first.',
    module: 'photos',
    tier: 'read',
    requires: ['SYNO.Foto.Browse.Item'],
    input: {
      space,
      album_id: z.number().int().optional(),
      folder_id: z.number().int().optional(),
      person_id: z.number().int().optional(),
      tag_id: z.number().int().optional(),
      ...paging,
    },
    handler: async ({ space: s, album_id, folder_id, person_id, tag_id, offset, limit }, { client, signal }) => {
      const page = { offset, limit, sort_by: 'takentime', sort_direction: 'desc', additional: ['resolution'] };
      let data: any;
      if (album_id !== undefined) {
        data = await foto(client, s, 'Browse.Item', 'list', { album_id, ...page }, { version: 2, signal });
      } else if (folder_id !== undefined) {
        data = await foto(client, s, 'Browse.Item', 'list', { folder_id, ...page }, { version: 2, signal });
      } else if (person_id !== undefined || tag_id !== undefined) {
        data = await foto(client, s, 'Browse.Item', 'list_with_filter', {
            ...(person_id !== undefined ? { person: [person_id], person_policy: 'or' } : {}),
            ...(tag_id !== undefined ? { general_tag: [tag_id], general_tag_policy: 'or' } : {}),
            ...page,
          }, { version: 2, signal });
      } else {
        data = await foto(client, s, 'Browse.RecentlyAdded', 'list', { offset, limit, additional: ['resolution'] }, { version: 1, signal });
      }
      return { offset, items: asList<any>(data.list).map(itemView) };
    },
  }),

  tool({
    name: 'photos_search',
    title: 'Search photos',
    description: 'Search a Photos library by keyword: file names, places, people, tags and recognized subjects.',
    module: 'photos',
    tier: 'read',
    requires: ['SYNO.Foto.Search.Search'],
    input: { keyword: z.string().min(1), space, ...paging },
    handler: async ({ keyword, space: s, offset, limit }, { client, signal }) => {
      const data = await foto(client, s, 'Search.Search', 'list_item', { keyword, offset, limit, additional: ['resolution'] }, { signal });
      return { keyword, offset, items: asList<any>(data.list).map(itemView) };
    },
  }),

  tool({
    name: 'photos_download',
    title: 'Download a photo',
    description: 'Download one original photo or video to this computer. local_folder must be inside the configured localRoots.',
    module: 'photos',
    tier: 'read',
    localWrite: true,
    requires: ['SYNO.Foto.Download', 'SYNO.Foto.Browse.Item'],
    input: {
      id: z.number().int(),
      local_folder: z.string().describe('Absolute local folder'),
      space,
      overwrite: z.boolean().default(false),
    },
    handler: async ({ id, local_folder, space: s, overwrite }, { client, config, signal }) => {
      const folder = resolveLocalPath(local_folder, config.localRoots, { mustExist: true });
      if (!statSync(folder).isDirectory()) throw new DsmError(`${folder} is not a folder.`, { kind: 'invalid_parameter' });
      const info = await foto(client, s, 'Browse.Item', 'get', { id: [id], additional: [] }, { version: 2, signal });
      const item = asList<any>(info.list)[0];
      if (!item) throw new DsmError(`No item ${id} in the ${s} space.`, { kind: 'not_found', hint: 'IDs belong to one space.' });
      const destination = resolveLocalPath(join(folder, item.filename), config.localRoots, { mustExist: false });
      if (existsSync(destination) && !overwrite) throw new DsmError(`Local file already exists: ${destination}`, { kind: 'already_exists', hint: 'Pass overwrite=true.' });
      const written = await client.downloadToFile(
        fotoApi(s, 'Download'),
        'download',
        { item_id: [id], force_download: true },
        destination,
        { version: 1, signal, timeoutMs: 1_800_000 },
      );
      return { id, saved_to: destination, size: bytes(written) };
    },
  }),

  tool({
    name: 'photos_album_create',
    title: 'Create a photo album',
    description: 'Create a personal album, optionally with items in it.',
    module: 'photos',
    tier: 'write',
    destructive: false,
    requires: ['SYNO.Foto.Browse.NormalAlbum'],
    input: {
      name: z.string().min(1),
      item_ids: z.array(z.number().int()).max(1000).default([]),
    },
    handler: async ({ name, item_ids }, { client, signal }) => {
      const data = await foto(client, 'personal', 'Browse.NormalAlbum', 'create', { name, item: item_ids }, { signal });
      return { album: data.album?.id ?? data.id, name, items: item_ids.length };
    },
  }),

  tool({
    name: 'photos_album_add',
    title: 'Add photos to an album',
    description: 'Add items to a personal album. DSM reports success even for ids that do not exist, so the reply re-reads the album.',
    module: 'photos',
    tier: 'write',
    destructive: false,
    idempotent: true,
    requires: ['SYNO.Foto.Browse.NormalAlbum'],
    input: {
      album_id: z.number().int(),
      item_ids: z.array(z.number().int()).min(1).max(1000),
    },
    handler: async ({ album_id, item_ids }, { client, signal }) => {
      await foto(client, 'personal', 'Browse.NormalAlbum', 'add_item', { id: album_id, item: item_ids }, { signal });
      const album = await foto(client, 'personal', 'Browse.Album', 'get', { id: [album_id], additional: [] }, { version: 2, signal });
      return { album_id, requested: item_ids.length, album_item_count: asList<any>(album.list)[0]?.item_count };
    },
  }),
];

// ------------------------------------------------------------------ Drive

const FILES = 'SYNO.SynologyDrive.Files';
const DRIVE_VERSION = 2;

function driveFileView(file: any): Record<string, unknown> {
  return {
    id: file.file_id ?? file.id,
    path: file.display_path ?? file.path,
    name: file.name,
    type: file.type ?? (file.content_type === 'dir' ? 'dir' : undefined),
    size: bytes(file.size),
    modified: isoTime(file.modified_time),
    owner: file.owner?.name ?? file.owner,
    shared: file.shared || undefined,
  };
}

export const driveTools: ToolDef[] = [
  tool({
    name: 'drive_status',
    title: 'Synology Drive status',
    description: 'Team folders and the devices currently syncing with Synology Drive.',
    module: 'drive',
    tier: 'read',
    requiresAny: ['SYNO.SynologyDrive.Connection', 'SYNO.SynologyDrive.TeamFolders'],
    handler: async (_args, { client, signal }) => {
      const [connections, team] = await Promise.all([
        client.tryCall('SYNO.SynologyDrive.Connection', 'list', {}, { version: 1, signal }),
        client.tryCall('SYNO.SynologyDrive.TeamFolders', 'list', { offset: 0, limit: 500 }, { version: 1, signal }),
      ]);
      return {
        connections: connections.ok
          ? asList<any>(connections.data.items).map((c) => ({
              client: c.client_name,
              ip: c.client_ip,
              type: c.client_type,
              version: c.client_version,
              status: c.client_status,
              last_auth: isoTime(c.last_auth_time),
            }))
          : { unavailable: connections.error.message },
        team_folders: team.ok ? asList<any>(team.data.items ?? team.data.team_folders ?? team.data) : { unavailable: team.error.message },
      };
    },
  }),

  tool({
    name: 'drive_list',
    title: 'List Drive files',
    description: 'Files in a Synology Drive folder. /mydrive is your own Drive; team folders are /team-folders/<name>.',
    module: 'drive',
    tier: 'read',
    requires: [FILES],
    input: {
      path: z.string().default('/mydrive'),
      sort_by: z.enum(['name', 'size', 'modified', 'created']).default('name'),
      descending: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    handler: async ({ path, sort_by, descending, offset, limit }, { client, signal }) => {
      const data = await client.call(
        FILES,
        'list',
        { path: normalizeNasPath(path), sort_by, sort_direction: descending ? 'DESC' : 'ASC', offset, limit },
        { version: DRIVE_VERSION, signal },
      );
      const files = asList<any>(data.items).map(driveFileView);
      const total = Number(data.total ?? files.length);
      return { path, total, offset, next_offset: offset + files.length < total ? offset + files.length : undefined, files };
    },
  }),

  tool({
    name: 'drive_search',
    title: 'Search Drive',
    description: 'Search Synology Drive by keyword under a folder.',
    module: 'drive',
    tier: 'read',
    requires: [FILES],
    input: {
      keyword: z.string().min(1),
      path: z.string().default('/mydrive'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    handler: async ({ keyword, path, limit }, { client, signal }) => {
      const data = await client.call(FILES, 'search', { keyword: q(keyword), path: normalizeNasPath(path), limit }, { version: DRIVE_VERSION, signal });
      return { total: data.total, files: asList<any>(data.items).map(driveFileView) };
    },
  }),

  tool({
    name: 'drive_labels',
    title: 'Drive labels',
    description: 'Label definitions in Synology Drive.',
    module: 'drive',
    tier: 'read',
    requires: ['SYNO.SynologyDrive.Labels'],
    handler: async (_args, { client, signal }) => {
      const data = await client.call('SYNO.SynologyDrive.Labels', 'list', {}, { version: 1, signal });
      return { labels: asList(data.items ?? data.labels) };
    },
  }),
];

// ------------------------------------------------------------------ Download Station

const DS_TASK = 'SYNO.DownloadStation2.Task';

export const downloadTools: ToolDef[] = [
  tool({
    name: 'downloads_list',
    title: 'List downloads',
    description: 'Download Station tasks with status, progress, size and speed.',
    module: 'downloads',
    tier: 'read',
    requires: [DS_TASK],
    handler: async (_args, { client, signal }) => {
      const data = await client.call(DS_TASK, 'list', { additional: ['detail', 'transfer'], limit: -1, offset: 0 }, { version: 2, signal });
      const tasks = asList<any>(data.task).map((t) => {
        const transfer = t.additional?.transfer ?? {};
        return {
          id: t.id,
          title: t.title,
          type: t.type,
          status: t.status,
          size: bytes(t.size),
          progress_pct: percent(transfer.size_downloaded, t.size),
          down_per_s: bytes(transfer.speed_download),
          up_per_s: bytes(transfer.speed_upload),
          destination: t.additional?.detail?.destination,
        };
      });
      return { total: data.total ?? tasks.length, tasks };
    },
  }),

  tool({
    name: 'download_add',
    title: 'Add a download',
    description: 'Add a download from a URL or magnet link. `destination` is a share-relative folder that already exists, with no leading slash, e.g. video/movies.',
    module: 'downloads',
    tier: 'write',
    destructive: false,
    requires: [DS_TASK],
    input: {
      url: z.string().min(1),
      destination: z.string().min(1),
    },
    handler: async ({ url, destination }, { client, signal }) => {
      await client.call(
        DS_TASK,
        'create',
        { type: q('url'), url: [url], destination: q(destination.replace(/^\/+/, '')), create_list: false },
        { version: 2, signal },
      );
      return { added: true, destination };
    },
  }),

  tool({
    name: 'download_control',
    title: 'Pause, resume or delete downloads',
    description: 'Pause, resume or delete Download Station tasks by id. Delete removes the task; finished files stay.',
    module: 'downloads',
    tier: 'write',
    destructive: true,
    requires: [DS_TASK],
    input: {
      ids: z.array(z.string()).min(1).max(100),
      action: z.enum(['pause', 'resume', 'delete']),
    },
    handler: async ({ ids, action }, { client, signal }) => {
      await client.call(DS_TASK, action, { id: ids, force_complete: action === 'delete' ? false : undefined }, { version: 2, signal });
      return { action, ids, done: true };
    },
  }),
];

// ------------------------------------------------------------------ VMs and cameras

const GUEST = 'SYNO.Virtualization.API.Guest';

export const vmTools: ToolDef[] = [
  tool({
    name: 'vm_list',
    title: 'List virtual machines',
    description: 'Virtual Machine Manager guests with state, vCPUs, RAM and storage.',
    module: 'vm',
    tier: 'read',
    requires: [GUEST],
    handler: async (_args, { client, signal }) => {
      const data = await client.call(GUEST, 'list', {}, { version: 1, signal });
      const guests = asList<any>(data.guests).map((g) => ({
        name: g.guest_name,
        status: g.status,
        vcpus: g.vcpu_num,
        ram_mib: g.vram_size,
        storage: g.storage_name,
        autorun: g.autorun,
      }));
      return { total: guests.length, guests };
    },
  }),

  tool({
    name: 'vm_control',
    title: 'Control a virtual machine',
    description: 'poweron, shutdown (graceful), restart or poweroff (forced, like pulling the plug) a virtual machine.',
    module: 'vm',
    tier: 'write',
    destructive: true,
    requires: [`${GUEST}.Action`],
    input: {
      name: z.string(),
      action: z.enum(['poweron', 'shutdown', 'restart', 'poweroff']),
      confirm: z.boolean().default(false).describe('Required for poweroff'),
    },
    handler: async ({ name, action, confirm }, { client, signal }) => {
      if (action === 'poweroff' && !confirm) {
        return confirmationNeeded({ would_force_off: name, warning: 'Unsaved data in the VM may be lost. Prefer shutdown.' });
      }
      await client.call(`${GUEST}.Action`, action, { guest_name: name }, { version: 1, signal, timeoutMs: 120_000 });
      return { vm: name, action, issued: true };
    },
  }),
];

export const surveillanceTools: ToolDef[] = [
  tool({
    name: 'surveillance_cameras',
    title: 'Surveillance Station cameras',
    description: 'Surveillance Station version and licences, and its cameras with model, address and whether they are online.',
    module: 'surveillance',
    tier: 'read',
    requires: ['SYNO.SurveillanceStation.Camera'],
    handler: async (_args, { client, signal }) => {
      const [info, cameras] = await Promise.all([
        client.tryCall('SYNO.SurveillanceStation.Info', 'GetInfo', {}, { version: 1, signal }),
        client.call('SYNO.SurveillanceStation.Camera', 'List', {}, { version: 9, signal }),
      ]);
      return {
        cameras_used: info.ok ? info.data.cameraNumber : undefined,
        licences: info.ok ? info.data.liscenseNumber : undefined,
        cameras: asList<any>(cameras.cameras).map((c) => ({
          id: c.id,
          name: c.newName ?? c.name,
          vendor: c.vendor,
          model: c.model,
          ip: c.ip,
          online: c.status === 1,
        })),
      };
    },
  }),
];
