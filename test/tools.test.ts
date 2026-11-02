import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLocalPath } from '../src/mcp/paths.js';
import { summarizeStorage } from '../src/tools/storage.js';
import { sanitizeDockerDetail } from '../src/tools/docker.js';
import { assertCallAllowed } from '../src/tools/generic.js';
import type { DsmError } from '../src/dsm/errors.js';
import { DsmFailure, FakeDsm } from './fake-dsm.js';
import { connect, type Harness } from './helpers.js';

const LIST = 'SYNO.FileStation.List';
const DELETE = 'SYNO.FileStation.Delete';
const COPYMOVE = 'SYNO.FileStation.CopyMove';
const SEARCH = 'SYNO.FileStation.Search';
const UPLOAD = 'SYNO.FileStation.Upload';
const DOWNLOAD = 'SYNO.FileStation.Download';

function withFiles(fake: FakeDsm): FakeDsm {
  return fake
    .on(LIST, 'list_share', () => ({ total: 1, shares: [{ path: '/docker', additional: { volume_status: { freespace: 1024, totalspace: 2048 } } }] }))
    .on(LIST, 'getinfo', (params) => {
      if (params.path === '/missing/file') return { files: [{ path: params.path, code: 408 }] };
      return { files: [{ path: params.path, isdir: params.path?.endsWith('dir'), additional: { size: 2048 } }] };
    })
    .on(LIST, 'list', (params) => {
      if (params.folder_path === '/nobin/#recycle') throw new DsmFailure(408);
      return { total: 3, files: [{ path: `${params.folder_path}/a.txt`, isdir: false, additional: { size: 10, time: { mtime: 1_700_000_000 } } }] };
    })
    .on('SYNO.Core.Share', 'list', () => ({ shares: [{ name: 'nobin', enable_recycle_bin: false }] }))
    .on('SYNO.FileStation.CreateFolder', 'create', () => ({ folders: [] }))
    .onRaw(DOWNLOAD, 'download', (res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('default content');
    });
}

describe('tool selection', () => {
  let fake: FakeDsm;
  let harness: Harness | undefined;

  beforeEach(async () => {
    fake = await withFiles(new FakeDsm())
      .on('SYNO.DSM.Info', 'getinfo', () => ({ model: 'DS923+', version_string: 'DSM 7.2.2', uptime: 3700 }))
      .on(DELETE, 'start', () => ({ taskid: 'FileStation_1' }))
      .on('SYNO.Core.User', 'list', () => ({ total: 0, users: [] }))
      .on('SYNO.Core.System', 'reboot', () => ({}))
      .start();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await fake.stop();
  });

  it('gives a read connection no way to change anything', async () => {
    harness = await connect(fake, { tier: 'read' });
    const { tools } = await harness.mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('files_list');
    expect(names).not.toContain('files_delete');
    expect(names).not.toContain('dsm_write');
    expect(names).not.toContain('nas_power');
    for (const t of tools) {
      if (!t.annotations?.destructiveHint) continue;
      // The only "destructive" read-tier tools write on this machine, not on the NAS.
      expect(['files_download', 'photos_download']).toContain(t.name);
    }
  });

  it('adds write tools at the write tier but keeps account management out', async () => {
    harness = await connect(fake, { tier: 'write' });
    const names = await harness.toolNames();
    expect(names).toContain('files_delete');
    expect(names).not.toContain('user_create');
    expect(names).not.toContain('dsm_write');
  });

  it('keeps power tools off even at the admin tier unless allowed', async () => {
    harness = await connect(fake, { tier: 'admin' });
    expect(await harness.toolNames()).not.toContain('nas_power');
    await harness.close();
    harness = await connect(fake, { tier: 'read', allowPower: true });
    expect(await harness.toolNames()).toContain('nas_power');
  });

  it('hides tools for packages the NAS does not have, and says why', async () => {
    harness = await connect(fake);
    const names = await harness.toolNames();
    expect(names).not.toContain('docker_containers');
    expect(names).not.toContain('vm_list');
    expect(names).toContain('files_list');
    const capabilities = await harness.call('nas_capabilities');
    expect(capabilities.hidden.package).toContain('docker_containers');
    expect(capabilities.hidden_detail.join()).toContain('SYNO.Docker.Container');
  });

  it('shows everything when the NAS cannot be reached at startup, so tools work once it can', async () => {
    const offline = await new FakeDsm().start();
    const url = offline.url;
    await offline.stop();
    const fakeUrlHolder = Object.assign(new FakeDsm(), { url });
    harness = await connect(fakeUrlHolder as FakeDsm);
    expect(await harness.toolNames()).toContain('docker_containers');
  });

  it('honors the module list', async () => {
    harness = await connect(fake, { modules: ['files'] });
    const names = await harness.toolNames();
    expect(names).toContain('files_list');
    expect(names).not.toContain('nas_overview');
    expect(names).not.toContain('users_list');
  });

  it('annotates reads as read-only and destructive tools as destructive', async () => {
    harness = await connect(fake);
    const { tools } = await harness.mcp.listTools();
    const find = (name: string) => tools.find((t) => t.name === name)!;
    expect(find('files_list').annotations?.readOnlyHint).toBe(true);
    expect(find('files_delete').annotations?.destructiveHint).toBe(true);
    expect(find('files_mkdir').annotations?.destructiveHint).toBe(false);
    expect(find('files_download').annotations?.readOnlyHint).toBe(false);
  });

  it('keeps tool definitions small enough for a client to load', async () => {
    harness = await connect(fake, { tier: 'admin', allowPower: true });
    const { tools } = await harness.mcp.listTools();
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeLessThan(500);
    }
  });

  it('reports errors as tool errors with a kind and a hint, not as protocol failures', async () => {
    harness = await connect(fake);
    const result = await harness.callRaw('system_info');
    expect(result.isError).toBeUndefined();
    const failed = await harness.callRaw('dsm_read', { api: 'SYNO.Nope', method: 'get' });
    expect(failed.isError).toBe(true);
    const parsed = JSON.parse(failed.text);
    expect(parsed.error.kind).toBe('api_not_found');
    expect(parsed.error.hint).toBeTruthy();
  });

  it('clips oversized output with a note saying how to narrow it', async () => {
    fake.on('SYNO.Big.Data', 'list', () => ({ text: 'x'.repeat(5_000) }));
    harness = await connect(fake, { maxOutputChars: 1_000 });
    const { text } = await harness.callRaw('dsm_read', { api: 'SYNO.Big.Data', method: 'list' });
    expect(text.length).toBeLessThan(1_200);
    expect(text).toContain('output truncated');
  });
});

describe('file tools', () => {
  let fake: FakeDsm;
  let harness: Harness;

  beforeEach(async () => {
    fake = await withFiles(new FakeDsm()).start();
  });

  afterEach(async () => {
    await harness?.close();
    await fake.stop();
  });

  describe('delete', () => {
    beforeEach(async () => {
      fake
        .on(DELETE, 'start', (params) => ({ taskid: `FileStation_${params.path}` }))
        .on(DELETE, 'status', (params) => ({ finished: true, path: params.taskid }));
      harness = await connect(fake);
    });

    it('only previews without confirm, deleting nothing', async () => {
      const preview = await harness.call('files_delete', { paths: ['/docker/old.log', '/nobin/x.log'] });
      expect(preview.confirm_required).toBe(true);
      expect(preview.would_delete[0]).toMatchObject({ path: '/docker/old.log', recoverable: true });
      expect(preview.would_delete[1]).toMatchObject({ path: '/nobin/x.log', recoverable: false });
      expect(preview.warning).toContain('gone for good');
      expect(fake.callsTo(DELETE)).toHaveLength(0);
    });

    it('sends one task per path, since comma-joined paths silently do nothing on DSM', async () => {
      const result = await harness.call('files_delete', { paths: ['/docker/a', '/docker/b'], confirm: true });
      expect(result.deleted).toEqual(['/docker/a', '/docker/b']);
      const starts = fake.callsTo(DELETE, 'start');
      expect(starts.map((s) => s.params.path)).toEqual(['/docker/a', '/docker/b']);
      expect(starts[0]!.version).toBe(2);
    });

    it.each([
      ['/docker', 'whole shared folder'],
      ['docker/', 'whole shared folder'],
      ['/docker/#recycle', 'whole recycle bin'],
      ['/homes/bob/#recycle', 'whole recycle bin'],
      ['/docker/../photo', 'relative part'],
    ])('refuses %s even with confirm', async (path, message) => {
      const { isError, text } = await harness.callRaw('files_delete', { paths: [path], confirm: true });
      expect(isError).toBe(true);
      expect(text).toContain(message);
      expect(fake.callsTo(DELETE)).toHaveLength(0);
    });

    it('refuses protected paths, at any depth and in any case', async () => {
      await harness.close();
      harness = await connect(fake, { protectedPaths: ['/backups'] });
      const { isError, text } = await harness.callRaw('files_delete', { paths: ['/BACKUPS/2024/db.sql'], confirm: true });
      expect(isError).toBe(true);
      expect(text).toContain('protected');
    });

    it('reports a failure DSM only mentions in the finished task status', async () => {
      fake.on(DELETE, 'status', () => ({ finished: true, errors: [{ code: 900, path: '/docker/dir' }] }));
      const { isError, text } = await harness.callRaw('files_delete', { paths: ['/docker/dir'], recursive: false, confirm: true });
      expect(isError).toBe(true);
      expect(text).toContain('recursive=true');
    });

    it('hands off a long delete with a handle, leaving it running, and lists what is left', async () => {
      fake.on(DELETE, 'status', () => ({ finished: false, progress: 0.4 }));
      const result = await harness.call('files_delete', { paths: ['/docker/big', '/docker/next'], confirm: true, wait_seconds: 1 });
      expect(result.status).toBe('still_running');
      expect(result.handle).toBe('delete:FileStation_/docker/big');
      expect(result.not_started).toEqual(['/docker/next']);
      expect(fake.callsTo(DELETE, 'stop')).toHaveLength(0);
    });
  });

  describe('copy and move', () => {
    beforeEach(async () => {
      fake.on(COPYMOVE, 'start', () => ({ taskid: 'FileStation_cm' })).on(COPYMOVE, 'status', () => ({ finished: true, processed_size: 2048, skipstatus: { status: 'none' } }));
      harness = await connect(fake);
    });

    it('sets remove_src only for a move', async () => {
      await harness.call('files_copy_move', { action: 'copy', paths: ['/docker/a'], destination: '/backup' });
      await harness.call('files_copy_move', { action: 'move', paths: ['/docker/a'], destination: '/backup' });
      expect(fake.callsTo(COPYMOVE, 'start').map((c) => c.params.remove_src)).toEqual(['false', 'true']);
    });

    it.each([
      [{ processed_size: 2048, total: 2048 }, '2.0 KiB'],
      [{ processed_size: 0, total: 4096 }, '4.0 KiB'],
      [{ processed_size: 0, total: 0 }, undefined],
      [{ processed_size: 0, total: -1 }, undefined],
      [{}, undefined],
    ])('never claims 0 B for a copy when DSM reports %j', async (reported, size) => {
      fake.on(COPYMOVE, 'status', () => ({ finished: true, skipstatus: { status: 'none' }, ...reported }));
      const result = await harness.call('files_copy_move', { action: 'copy', paths: ['/docker/a'], destination: '/backup' });
      expect(result.items[0].size).toBe(size);
    });

    it('reports no size for an item DSM skipped', async () => {
      fake.on(COPYMOVE, 'status', () => ({ finished: true, total: 4096, skipstatus: { status: 'all' } }));
      const result = await harness.call('files_copy_move', { action: 'copy', paths: ['/docker/a'], destination: '/backup' });
      expect(result.items[0].size).toBeUndefined();
    });

    it('reports items DSM skipped, which it only mentions in the status', async () => {
      fake.on(COPYMOVE, 'status', () => ({ finished: true, skipstatus: { status: 'all' } }));
      const result = await harness.call('files_copy_move', { action: 'copy', paths: ['/docker/a'], destination: '/backup' });
      expect(result.items[0].skipped).toBe(true);
      expect(result.note).toContain('overwrite=true');
    });

    it('refuses to move a whole shared folder but allows copying one', async () => {
      const moved = await harness.callRaw('files_copy_move', { action: 'move', paths: ['/docker'], destination: '/backup' });
      expect(moved.isError).toBe(true);
      const copied = await harness.callRaw('files_copy_move', { action: 'copy', paths: ['/docker'], destination: '/backup' });
      expect(copied.isError).toBeUndefined();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      fake
        .on(SEARCH, 'start', () => ({ taskid: '17918443788CE649B9' }))
        .on(SEARCH, 'list', () => ({ finished: true, total: 1, files: [{ path: '/docker/report.pdf', isdir: false, additional: { size: 5 } }] }))
        .on(SEARCH, 'stop', () => ({}))
        .on(SEARCH, 'clean', () => ({}));
      harness = await connect(fake);
    });

    it('quotes the task id, which DSM otherwise misreads, and always cleans up', async () => {
      await harness.call('files_search', { folder: '/docker', pattern: 'report' });
      expect(fake.callsTo(SEARCH, 'list')[0]!.params.taskid).toBe('"17918443788CE649B9"');
      expect(fake.callsTo(SEARCH, 'stop')).toHaveLength(1);
      expect(fake.callsTo(SEARCH, 'clean')).toHaveLength(1);
    });

    it('wraps a bare word so it matches anywhere in the name', async () => {
      await harness.call('files_search', { folder: '/docker', pattern: 'report' });
      expect(fake.callsTo(SEARCH, 'start')[0]!.params.pattern).toBe('"*report*"');
    });

    it('turns *.pdf into the extension filter', async () => {
      await harness.call('files_search', { folder: '/docker', pattern: '*.pdf' });
      const params = fake.callsTo(SEARCH, 'start')[0]!.params;
      expect(params.extension).toBe('"pdf"');
      expect(params.pattern).toBeUndefined();
    });

    it('does not read an unknown-task reply as zero results', async () => {
      fake.on(SEARCH, 'list', () => ({ finished: true }));
      const { isError, text } = await harness.callRaw('files_search', { folder: '/docker', pattern: 'x' });
      expect(isError).toBe(true);
      expect(text).toContain('lost track');
    });

    it('still cleans up when the search fails midway', async () => {
      fake.on(SEARCH, 'list', () => {
        throw new DsmFailure(401);
      });
      await harness.callRaw('files_search', { folder: '/docker', pattern: 'x' });
      expect(fake.callsTo(SEARCH, 'stop')).toHaveLength(1);
      expect(fake.callsTo(SEARCH, 'clean')).toHaveLength(1);
    });
  });

  describe('reading and writing', () => {
    beforeEach(async () => {
      fake.on(UPLOAD, 'upload', () => ({}));
      harness = await connect(fake);
    });

    it('uploads with the file part last and quotes nothing DSM reads raw', async () => {
      const result = await harness.call('files_write', { path: '/docker/app/notes.txt', content: 'olá mundo' });
      expect(result.written).toBe('/docker/app/notes.txt');
      const call = fake.callsTo(UPLOAD, 'upload')[0]!;
      expect(call.params.path).toBe('/docker/app');
      expect(call.file).toEqual({ name: 'notes.txt', content: 'olá mundo' });
      expect(call.version).toBe(2);
    });

    it('omits overwrite unless asked, since overwrite=false makes DSM skip silently', async () => {
      await harness.call('files_write', { path: '/docker/a.txt', content: 'x' });
      expect(fake.callsTo(UPLOAD, 'upload')[0]!.params.overwrite).toBeUndefined();
      await harness.call('files_write', { path: '/docker/a.txt', content: 'x', overwrite: true });
      expect(fake.callsTo(UPLOAD, 'upload')[1]!.params.overwrite).toBe('true');
    });

    it('never reports a skipped upload as written', async () => {
      fake.on(UPLOAD, 'upload', () => ({ blSkip: true }));
      const { isError, text } = await harness.callRaw('files_write', { path: '/docker/a.txt', content: 'x' });
      expect(isError).toBe(true);
      expect(text).toContain('already_exists');
    });

    it('reads text with paging information', async () => {
      fake.onRaw(DOWNLOAD, 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('hello world');
      });
      const result = await harness.call('files_read', { path: '/docker/a.txt', max_bytes: 5 });
      expect(result.content).toBe('hello');
      expect(result.truncated).toBe(true);
      expect(result.next_offset).toBe(5);
      const next = await harness.call('files_read', { path: '/docker/a.txt', offset: 5, max_bytes: 100 });
      expect(next.content).toBe(' world');
      expect(next.truncated).toBe(false);
    });

    it('refuses binary as text instead of returning garbage', async () => {
      fake.onRaw(DOWNLOAD, 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0xff, 0xfe, 0x00, 0x80]));
      });
      const { isError, text } = await harness.callRaw('files_read', { path: '/docker/a.bin' });
      expect(isError).toBe(true);
      expect(text).toContain('base64');
    });

    it('recognizes binary even when only part of the file is read', async () => {
      fake.onRaw(DOWNLOAD, 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat([Buffer.from('PK'), Buffer.alloc(4), Buffer.from('more content here')]));
      });
      const { isError, text } = await harness.callRaw('files_read', { path: '/docker/a.zip', max_bytes: 8 });
      expect(isError).toBe(true);
      expect(text).toContain('not UTF-8');
    });

    it('turns a JSON reply to a download into the error it carries', async () => {
      fake.onRaw(DOWNLOAD, 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 407 } }));
      });
      const { isError, text } = await harness.callRaw('files_read', { path: '/docker/a.txt' });
      expect(isError).toBe(true);
      expect(JSON.parse(text).error.kind).toBe('permission_denied');
    });
  });

  describe('local paths', () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-root-')));
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-out-')));
      writeFileSync(join(root, 'in.txt'), 'inside');
      writeFileSync(join(outside, 'secret.txt'), 'outside');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      fake.on(UPLOAD, 'upload', () => ({}));
      fake.onRaw(DOWNLOAD, 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('remote data');
      });
      harness = await connect(fake, { localRoots: [root] });
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it('uploads from inside the allowed folder', async () => {
      await harness.call('files_upload', { local_path: join(root, 'in.txt'), folder: '/docker' });
      expect(fake.callsTo(UPLOAD, 'upload')[0]!.file?.content).toBe('inside');
    });

    it('refuses paths outside it, and symlinks leading outside it', async () => {
      for (const local_path of [join(outside, 'secret.txt'), join(root, 'link.txt'), join(root, '..', 'secret.txt')]) {
        const { isError } = await harness.callRaw('files_upload', { local_path, folder: '/docker' });
        expect(isError, local_path).toBe(true);
      }
      expect(fake.callsTo(UPLOAD)).toHaveLength(0);
    });

    it('downloads into the folder and will not replace a file unless asked', async () => {
      const result = await harness.call('files_download', { path: '/docker/data.bin', local_path: root });
      expect(result.saved_to).toBe(join(root, 'data.bin'));
      expect(readFileSync(join(root, 'data.bin'), 'utf8')).toBe('remote data');
      const again = await harness.callRaw('files_download', { path: '/docker/data.bin', local_path: root });
      expect(again.isError).toBe(true);
      expect(again.text).toContain('overwrite=true');
    });

    describe('what a refusal reveals', () => {
      const attempt = (path: string, mustExist: boolean): { kind?: string; message: string } => {
        try {
          return { message: `allowed: ${resolveLocalPath(path, [root], { mustExist })}` };
        } catch (error) {
          return { kind: (error as DsmError).kind, message: (error as DsmError).message };
        }
      };

      it.each([true, false])('answers the same for outside paths that do and do not exist (mustExist=%s)', (mustExist) => {
        const present = attempt(join(outside, 'secret.txt'), mustExist);
        const absent = attempt(join(outside, 'no-such-file.txt'), mustExist);
        const absentFolder = attempt(join(outside, 'no-such-folder', 'file.txt'), mustExist);
        for (const result of [present, absent, absentFolder]) {
          expect(result.kind).toBe('refused');
          expect(result.message).not.toContain('does not exist');
        }
      });

      it('does the same beyond a symlink inside the allowed folder, without naming its target', () => {
        symlinkSync(outside, join(root, 'door'));
        for (const name of ['secret.txt', 'no-such-file.txt', 'no-such-folder/file.txt']) {
          const result = attempt(join(root, 'door', name), true);
          expect(result.kind, name).toBe('refused');
          expect(result.message, name).not.toContain(outside);
        }
      });

      it('still says when something is missing inside the allowed folder', () => {
        expect(attempt(join(root, 'missing.txt'), true).kind).toBe('not_found');
        expect(attempt(join(root, 'missing', 'file.txt'), false).kind).toBe('not_found');
        expect(attempt(join(root, 'new.txt'), false).message).toBe(`allowed: ${join(root, 'new.txt')}`);
        expect(attempt(root, true).message).toBe(`allowed: ${root}`);
      });
    });

    it('will not download outside the allowed folder', async () => {
      const { isError } = await harness.callRaw('files_download', { path: '/docker/data.bin', local_path: join(outside, 'x') });
      expect(isError).toBe(true);
    });
  });
});

describe('generic DSM access', () => {
  let fake: FakeDsm;
  let harness: Harness;

  beforeEach(async () => {
    fake = await new FakeDsm()
      .on('SYNO.Core.Quota', 'get', (params) => ({ echo: params.name, password: 'hunter2', nested: { synotoken: 'abc', on: true } }))
      .on('SYNO.Core.Quota', 'set', () => ({ saved: true }))
      .start();
    harness = await connect(fake);
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
  });

  it('finds APIs in the NAS catalog by words', async () => {
    const result = await harness.call('dsm_api_search', { query: 'core quota' });
    expect(result.apis).toEqual([{ api: 'SYNO.Core.Quota', versions: '1-9' }]);
  });

  it('calls read methods, quoting strings as DSM\'s web client does, and redacts secrets', async () => {
    const result = await harness.call('dsm_read', { api: 'SYNO.Core.Quota', method: 'get', params: { name: '2024' } });
    expect(fake.callsTo('SYNO.Core.Quota')[0]!.params.name).toBe('"2024"');
    expect(result.password).toBe('[redacted]');
    expect(result.nested.synotoken).toBe('[redacted]');
    expect(result.nested.on).toBe(true);
  });

  it('refuses a state-changing method through dsm_read', async () => {
    const { isError, text } = await harness.callRaw('dsm_read', { api: 'SYNO.Core.Quota', method: 'set' });
    expect(isError).toBe(true);
    expect(text).toContain('dsm_write');
    expect(fake.callsTo('SYNO.Core.Quota')).toHaveLength(0);
  });

  it('previews a write until confirmed, without sending it', async () => {
    const preview = await harness.call('dsm_write', { api: 'SYNO.Core.Quota', method: 'set', params: { password: 'x', quota: 5 } });
    expect(preview.confirm_required).toBe(true);
    expect(preview.params.password).toBe('[redacted]');
    expect(fake.callsTo('SYNO.Core.Quota')).toHaveLength(0);
    const done = await harness.call('dsm_write', { api: 'SYNO.Core.Quota', method: 'set', params: { quota: 5 }, confirm: true });
    expect(done.saved).toBe(true);
  });

  it.each([
    ['SYNO.API.Auth', 'login'],
    ['SYNO.Core.OTP', 'get'],
    ['SYNO.Core.Factory.Config', 'set'],
    ['SYNO.Core.ResetAdmin', 'set'],
    ['SYNO.Core.Share.KeyManager.Key', 'list'],
    ['SYNO.Storage.CGI.KMIP', 'erase_all_data'],
    ['SYNO.Storage.CGI.Pool', 'delete'],
    ['SYNO.Storage.CGI.Volume', 'delete'],
    ['SYNO.Storage.CGI.HddMan', 'secure_erase'],
    ['SYNO.Core.Storage.Disk', 'set'],
    ['SYNO.Core.System', 'reboot'],
    ['SYNO.Core.System', 'shutdown'],
    ['SYNO.Core.Upgrade', 'start'],
    ['NOT.A.Synology.Api', 'get'],
  ])('refuses %s/%s', (api, method) => {
    expect(() => assertCallAllowed(api, method, { allowPower: false })).toThrow();
  });

  it('allows reading storage, and power only when power is on', () => {
    expect(() => assertCallAllowed('SYNO.Storage.CGI.Storage', 'load_info', { allowPower: false })).not.toThrow();
    expect(() => assertCallAllowed('SYNO.Core.System', 'reboot', { allowPower: true })).not.toThrow();
    expect(() => assertCallAllowed('SYNO.Core.Upgrade', 'status', { allowPower: false })).not.toThrow();
  });
});

describe('system and storage', () => {
  it('flags what needs attention in storage', () => {
    const summary = summarizeStorage({
      volumes: [
        { vol_path: '/volume1', status: 'normal', size: { total: 1000, used: 950 } },
        { vol_path: '/volume2', status: 'crashed', size: { total: 1000, used: 10 } },
      ],
      storagePools: [{ id: 'pool1', status: 'degrade', disks: ['sda'] }],
      disks: [
        { id: 'sda', name: 'Drive 1', status: 'normal', smart_status: 'normal', temp: 40 },
        { id: 'sdb', name: 'Drive 2', status: 'normal', smart_status: 'failing', temp: 65, unc: 3 },
        { id: 'sdc', name: 'Drive 3', overview_status: 'not_use', temp: 30, remain_life: { value: 4 } },
      ],
    });
    const text = summary.attention.join('\n');
    expect(text).toContain('/volume1 is 95% full');
    expect(text).toContain('/volume2 status is "crashed"');
    expect(text).toContain('pool1 status is "degrade"');
    expect(text).toContain('Drive 2 S.M.A.R.T.');
    expect(text).toContain('Drive 2 is at 65');
    expect(text).toContain('Drive 2 has 3 uncorrectable');
    expect(text).toContain('Drive 3 has 4% life');
    expect(text).not.toContain('Drive 1');
    expect(summary.volumes[0]).toMatchObject({ used_pct: 95 });
  });

  it('copes with a NAS that has no disks to report', () => {
    expect(summarizeStorage({})).toEqual({ volumes: [], pools: [], disks: [], caches: [], attention: [] });
  });

  it('builds the overview even when some sections are unavailable', async () => {
    const fake = await new FakeDsm()
      .on('SYNO.DSM.Info', 'getinfo', () => ({ model: 'DS923+', version_string: 'DSM 7.2.2', uptime: 90_000, temperature: 41 }))
      .on('SYNO.Storage.CGI.Storage', 'load_info', () => {
        throw new DsmFailure(105);
      })
      .start();
    const harness = await connect(fake);
    const overview = await harness.call('nas_overview');
    expect(overview.nas).toMatchObject({ model: 'DS923+', uptime: '1d 1h 0m' });
    expect(overview.unavailable.storage).toContain('permission');
    await harness.close();
    await fake.stop();
  });

  it('renews a 2FA token through nas_auth_otp and stores it', async () => {
    const fake = await new FakeDsm({ otp: '654321' }).on('SYNO.DSM.Info', 'getinfo', () => ({ model: 'X' })).start();
    const harness = await connect(fake);
    const refused = await harness.callRaw('system_info');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('nas_auth_otp');
    const logins = fake.logins.length;
    const wrong = await harness.callRaw('nas_auth_otp', { code: '000000' });
    expect(wrong.isError).toBe(true);
    const result = await harness.call('nas_auth_otp', { code: '654321' });
    expect(result).toMatchObject({ logged_in: true, device_token_saved: true });
    expect((await harness.credentials.resolve())?.deviceId).toBe('device-token-1');
    expect(fake.logins.length).toBe(logins + 2);
    await expect(harness.call('system_info')).resolves.toMatchObject({ model: 'X' });
    await harness.close();
    await fake.stop();
  });

  it('asks for confirmation before powering down and uses the power API only once allowed', async () => {
    const fake = await new FakeDsm().on('SYNO.Core.System', 'shutdown', () => ({})).start();
    const harness = await connect(fake, { allowPower: true });
    const preview = await harness.call('nas_power', { action: 'shutdown' });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Core.System')).toHaveLength(0);
    await harness.call('nas_power', { action: 'shutdown', confirm: true });
    expect(fake.callsTo('SYNO.Core.System', 'shutdown')).toHaveLength(1);
    await harness.close();
    await fake.stop();
  });
});

describe('Container Manager', () => {
  it('keeps env values out of container detail unless asked', () => {
    const detail = {
      name: 'db',
      profile: { env_variables: [{ key: 'POSTGRES_PASSWORD', value: 'hunter2' }, { key: 'TZ', value: 'UTC' }], cmd: 'run' },
      details: { Config: { Env: ['API_KEY=abc', 'PATH=/bin'] } },
    };
    const clean = JSON.stringify(sanitizeDockerDetail(detail));
    expect(clean).not.toContain('hunter2');
    expect(clean).not.toContain('abc');
    expect(clean).toContain('POSTGRES_PASSWORD');
    expect(clean).toContain('API_KEY');
    const full = JSON.stringify(sanitizeDockerDetail(detail, { env: true }));
    expect(full).toContain('hunter2');
  });

  it('drives a project by name, through its id and the stream method', async () => {
    const fake = await new FakeDsm()
      .on('SYNO.Docker.Project', 'list', () => ({ 'uuid-1': { id: 'uuid-1', name: 'web', status: 'RUNNING', containerIds: ['a'] } }))
      .onRaw('SYNO.Docker.Project', 'build_stream', (res) => {
        res.write('Building\n');
        res.end('Exit Code: 0\n');
      })
      .onRaw('SYNO.Docker.Project', 'start_stream', (res) => {
        res.end('boom\nExit Code: 2\n');
      })
      .start();
    const harness = await connect(fake);
    const built = await harness.call('docker_project_control', { name: 'web', action: 'build' });
    expect(built).toMatchObject({ done: true, exit_code: 0 });
    expect(fake.calls.at(-1)!.params.id).toBe('"uuid-1"');
    const failed = await harness.callRaw('docker_project_control', { name: 'web', action: 'start' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('exit code 2');
    const missing = await harness.callRaw('docker_project_control', { name: 'nope', action: 'build' });
    expect(missing.text).toContain('Known projects: web');
    await harness.close();
    await fake.stop();
  });

  it('previews deletions and quotes container names', async () => {
    const fake = await new FakeDsm()
      .on('SYNO.Docker.Container', 'get', () => ({ name: 'app' }))
      .on('SYNO.Docker.Container', 'delete', () => ({}))
      .start();
    const harness = await connect(fake);
    const preview = await harness.call('docker_delete', { kind: 'container', name: 'app' });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Docker.Container', 'delete')).toHaveLength(0);
    await harness.call('docker_delete', { kind: 'container', name: 'app', confirm: true });
    expect(fake.callsTo('SYNO.Docker.Container', 'delete')[0]!.params.name).toBe('"app"');
    await harness.close();
    await fake.stop();
  });
});

describe('accounts', () => {
  let fake: FakeDsm;
  let harness: Harness;

  beforeEach(async () => {
    fake = await new FakeDsm()
      .on('SYNO.Core.User', 'create', () => ({}))
      .on('SYNO.Core.User', 'set', () => ({}))
      .on('SYNO.Core.User', 'get', () => ({ users: [{ name: 'bob' }] }))
      .on('SYNO.Core.User', 'delete', () => ({}))
      .on('SYNO.Core.Share', 'list', () => ({ shares: [{ name: 'media', vol_path: '/volume1' }] }))
      .on('SYNO.Core.Share', 'delete', () => ({}))
      .start();
    harness = await connect(fake);
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
  });

  it('refuses a password DSM would read as something else', async () => {
    for (const password of ['123456', 'true', 'null', '[1]']) {
      const { isError } = await harness.callRaw('user_create', { name: 'bob', password });
      expect(isError, password).toBe(true);
    }
    expect(fake.callsTo('SYNO.Core.User', 'create')).toHaveLength(0);
    await harness.call('user_create', { name: 'bob', password: 'S3cure!pass' });
    expect(fake.callsTo('SYNO.Core.User', 'create')).toHaveLength(1);
  });

  it('will not delete or disable the account the server itself uses', async () => {
    expect((await harness.callRaw('user_delete', { name: 'alice', confirm: true })).isError).toBe(true);
    expect((await harness.callRaw('user_update', { name: 'alice', enabled: false })).isError).toBe(true);
    expect(fake.callsTo('SYNO.Core.User', 'delete')).toHaveLength(0);
    expect(fake.callsTo('SYNO.Core.User', 'set')).toHaveLength(0);
  });

  it('needs the exact share name typed back before deleting a shared folder', async () => {
    const preview = await harness.call('share_delete', { name: 'media' });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Core.Share', 'delete')).toHaveLength(0);
    const wrong = await harness.call('share_delete', { name: 'media', confirm_name: 'Media' });
    expect(wrong.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Core.Share', 'delete')).toHaveLength(0);
    await harness.call('share_delete', { name: 'media', confirm_name: 'media' });
    expect(fake.callsTo('SYNO.Core.Share', 'delete')).toHaveLength(1);
  });

  it('sends share creation in the envelope DSM 7.3.2 requires', async () => {
    fake.on('SYNO.Core.Share', 'create', () => ({}));
    await harness.call('share_create', { name: '2024' });
    const params = fake.callsTo('SYNO.Core.Share', 'create')[0]!.params;
    expect(params.name).toBe('"2024"');
    expect(JSON.parse(params.shareinfo!)).toMatchObject({ name: '2024', vol_path: '/volume1', enable_recycle_bin: true });
  });
});
