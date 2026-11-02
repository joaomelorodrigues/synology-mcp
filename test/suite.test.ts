import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUITE_OPS } from '../src/suite/catalog.js';
import { assertNotProtected } from '../src/mcp/paths.js';
import { drivePath, driveLocation } from '../src/tools/apps.js';
import { calendarTools, driveApiTools, mailTools, suiteMetaTools } from '../src/tools/suite.js';
import { DsmFailure, FakeDsm } from './fake-dsm.js';
import { connect, type Harness } from './helpers.js';

const FILES = 'SYNO.SynologyDrive.Files';
const SHARING = 'SYNO.SynologyDrive.Sharing';
const REQUESTS = 'SYNO.SynologyDrive.FileRequest';
const TASKS = 'SYNO.SynologyDrive.Tasks';

describe('Drive paths', () => {
  it.each([
    ['/mydrive/a.txt', '/mydrive/a.txt'],
    ['/mydrive/', '/mydrive'],
    ['/team-folders/Acme/a.txt', '/team-folders/Acme/a.txt'],
    ['/shared-with-me/a.txt', '/shared-with-me/a.txt'],
    ['/Acme/Plans/a.osheet', '/team-folders/Acme/Plans/a.osheet'],
    ['/Acme', '/team-folders/Acme'],
    ['/home/Drive/a.txt', '/mydrive/a.txt'],
    ['/home/Drive', '/mydrive'],
    ['id:42', 'id:42'],
    ['link:ABC', 'link:ABC'],
  ])('reads %s as %s', (input, expected) => {
    expect(drivePath(input)).toBe(expected);
  });

  it.each(['/home/Other/a.txt', '/home', '/homes/bob/Drive/a.txt'])('refuses %s, which is not in Drive', (input) => {
    expect(() => drivePath(input)).toThrow(/not in Drive/);
  });

  it('finds search locations the same way', () => {
    expect(driveLocation('/mydrive')).toBe('mydrive');
    expect(driveLocation('/Acme/Plans')).toBe('/team-folders/Acme/Plans');
  });
});

function withVersions(fake: FakeDsm): FakeDsm {
  for (const entry of Object.values(fake.catalog)) entry.maxVersion = Math.max(entry.maxVersion, 11);
  return fake;
}

describe('published Office Suite catalog', () => {
  it('keeps descriptions short and covers every published product', () => {
    for (const def of [...suiteMetaTools, ...driveApiTools, ...mailTools, ...calendarTools]) {
      expect(def.description.length, def.name).toBeLessThan(500);
    }
    const products = new Set(SUITE_OPS.map((op) => op.product));
    expect(products).toEqual(new Set(['drive', 'mail', 'calendar', 'spreadsheet']));
    expect(SUITE_OPS.some((op) => op.id === 'drive.Files.list')).toBe(true);
    expect(SUITE_OPS.some((op) => op.syno?.api === 'SYNO.API.Auth')).toBe(false);
  });
});

describe('Drive, MailPlus and Calendar tools', () => {
  let fake: FakeDsm;
  let harness: Harness;
  let root: string;
  let dryRunResult: unknown[];

  beforeEach(async () => {
    dryRunResult = [];
    fake = withVersions(
      new FakeDsm()
        .on(FILES, 'list', () => ({ total: 1, items: [{ name: 'a.txt', file_id: '1', display_path: '/mydrive/a.txt', size: 4 }] }))
        .on(FILES, 'search', () => ({ total: 0, items: [] }))
        .on(FILES, 'get', () => ({ name: 'a.txt', file_id: '1', display_path: '/mydrive/a.txt', permanent_link: 'LINK' }))
        .on(FILES, 'delete', () => ({ async_task_id: 'task-1' }))
        .on(FILES, 'request_access', () => ({}))
        .on(FILES, 'upload', (_params, call) => (call.headers['x-file-chunk-end'] === 'false' ? { uploaded_size: 0, tmp_newly_created: true } : { name: 'up.txt', file_id: '2', display_path: '/mydrive/up.txt' }))
        .on(TASKS, 'get', () => ({ status: 'finished', task_id: 'zip1', result: { archive_name: 'drive' } }))
        .onRaw(FILES, 'download', (res, call) => {
          const json = (data: unknown): void => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, data }));
          };
          if (call.params.task_id) {
            res.writeHead(200, { 'content-type': 'application/zip' });
            res.end('zip-bytes');
          } else if (call.params.dry_run) {
            json({ result: dryRunResult });
          } else if (call.params.archive_name) {
            json({ async_task_id: 'zip1' });
          } else {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end('file-bytes');
          }
        })
        .on(SHARING, 'list', () => ({ items: [] }))
        .on(SHARING, 'create_link', () => ({ url: 'https://nas/d/s/abc' }))
        .on(SHARING, 'update', () => ({}))
        .on(REQUESTS, 'list', () => ({ items: [{ protect_password: 'hunter2' }] }))
        .on(REQUESTS, 'create', () => ({ sharing_link: 'req1', url: 'https://nas/d/f/req1' }))
        .on(REQUESTS, 'update', () => ({ sharing_link: 'req1' })),
    );
    await fake.start();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'suite-')));
    harness = await connect(fake, { localRoots: [root] });
  });

  afterEach(async () => {
    await harness?.close();
    await fake?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('uploads the way Drive does in the browser: a probe, then the file, in the same slice session', async () => {
    writeFileSync(join(root, 'up.txt'), 'data');
    const result = await harness.call('drive_upload', { local_path: join(root, 'up.txt'), path: '/mydrive/up.txt' });
    expect(result).toMatchObject({ uploaded: 'up.txt', path: '/mydrive/up.txt' });
    const [probe, upload] = fake.callsTo(FILES, 'upload');
    expect(probe!.file!.content).toBe('');
    expect(probe!.headers['x-file-chunk-end']).toBe('false');
    expect(upload!.file!.content).toBe('data');
    expect(upload!.headers['x-file-chunk-end']).toBe('true');
    expect(upload!.headers['x-type-name']).toBe('SLICEUPLOAD');
    expect(upload!.headers['x-tmp-file']).toMatch(/^[0-9a-f]{32}$/);
    expect(upload!.headers['x-tmp-file']).toBe(probe!.headers['x-tmp-file']);
    expect(upload!.version).toBe(2);
  });

  it('sends only the part of the file the NAS does not hold yet', async () => {
    fake.on(FILES, 'upload', (_params, call) => (call.headers['x-file-chunk-end'] === 'false' ? { uploaded_size: 2, tmp_newly_created: false } : { name: 'up.txt' }));
    writeFileSync(join(root, 'up.txt'), 'data');
    await harness.call('drive_upload', { local_path: join(root, 'up.txt'), path: '/mydrive/up.txt' });
    expect(fake.callsTo(FILES, 'upload')[1]!.file!.content).toBe('ta');
  });

  it('sends upload values unquoted in the form, and the rest in the URL, as the browser does', async () => {
    writeFileSync(join(root, 'up.txt'), 'data');
    await harness.call('drive_upload', { local_path: join(root, 'up.txt'), path: '/mydrive/up.txt', on_conflict: 'version' });
    const call = fake.callsTo(FILES, 'upload')[1]!;
    expect(call.params).toMatchObject({ path: '/mydrive/up.txt', type: 'file', conflict_action: 'version' });
    const query = new URL(call.url, 'http://x').searchParams;
    expect(query.get('api')).toBe(FILES);
    expect(query.get('method')).toBe('upload');
    expect(query.get('version')).toBe('2');
    expect(Number(query.get('modified_time'))).toBeGreaterThan(1_000_000_000);
    expect(query.get('path')).toBeNull();
  });

  describe('drive_download', () => {
    it('streams one file directly', async () => {
      const result = await harness.call('drive_download', { files: ['/mydrive/a.txt'], local_path: root });
      expect(result.saved_to).toBe(join(root, 'a.txt'));
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('file-bytes');
      expect(fake.callsTo(FILES, 'download')).toHaveLength(1);
    });

    it('builds several files into a ZIP through a background task, then fetches it', async () => {
      const result = await harness.call('drive_download', { files: ['/mydrive/a.txt', '/mydrive/b.txt'], local_path: root });
      expect(result).toMatchObject({ saved_to: join(root, 'drive.zip'), files: 2 });
      expect(readFileSync(join(root, 'drive.zip'), 'utf8')).toBe('zip-bytes');
      const [dry, start, fetched] = fake.callsTo(FILES, 'download');
      expect(dry!.params).toMatchObject({ dry_run: 'true', archive_name: '"drive"', download_type: '"download"', force_download: 'true', json_error: 'true', files: '["/mydrive/a.txt","/mydrive/b.txt"]' });
      expect(start!.params.dry_run).toBeUndefined();
      expect(start!.params.archive_name).toBe('"drive"');
      expect(fake.callsTo(TASKS, 'get')[0]!.params.task_id).toBe('"zip1"');
      expect(fetched!.params.task_id).toBe('"zip1"');
      expect(fetched!.version).toBe(2);
    });

    it('zips a single folder too, named after it', async () => {
      fake.on(FILES, 'get', () => ({ name: 'Reports', file_id: '9', type: 'dir', display_path: '/mydrive/Reports' }));
      const result = await harness.call('drive_download', { files: ['/mydrive/Reports'], local_path: root });
      expect(result.saved_to).toBe(join(root, 'Reports.zip'));
      expect(fake.callsTo(FILES, 'download')[0]!.params.archive_name).toBe('"Reports"');
    });

    it('says which files are encrypted instead of starting a ZIP that fails', async () => {
      dryRunResult = [{ name: 'locked.osheet' }];
      const { isError, text } = await harness.callRaw('drive_download', { files: ['/mydrive/a.txt', '/mydrive/locked.osheet'], local_path: root });
      expect(isError).toBe(true);
      expect(text).toContain('locked.osheet');
      expect(text).toContain('office_export');
      expect(fake.callsTo(FILES, 'download')).toHaveLength(1);
    });

    it('hands over a task still running, and fetches it on a second call without starting again', async () => {
      fake.on(TASKS, 'get', () => ({ status: 'running' }));
      const waiting = await harness.call('drive_download', { files: ['/mydrive/a.txt', '/mydrive/b.txt'], local_path: root, wait_seconds: 0 });
      expect(waiting).toMatchObject({ status: 'still_running', task_id: 'zip1' });
      expect(existsSync(join(root, 'drive.zip'))).toBe(false);

      fake.on(TASKS, 'get', () => ({ status: 'finished', result: {} }));
      const before = fake.callsTo(FILES, 'download').length;
      const done = await harness.call('drive_download', { files: ['/mydrive/a.txt', '/mydrive/b.txt'], local_path: root, task_id: 'zip1' });
      expect(done.saved_to).toBe(join(root, 'drive.zip'));
      const calls = fake.callsTo(FILES, 'download').slice(before);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params.task_id).toBe('"zip1"');
    });

    it('checks the local path before asking the NAS to build anything', async () => {
      writeFileSync(join(root, 'drive.zip'), 'old');
      const { isError, text } = await harness.callRaw('drive_download', { files: ['/mydrive/a.txt', '/mydrive/b.txt'], local_path: root });
      expect(isError).toBe(true);
      expect(text).toContain('already exists');
      expect(fake.callsTo(FILES, 'download')).toHaveLength(0);
      expect(readFileSync(join(root, 'drive.zip'), 'utf8')).toBe('old');
    });

    it('names a single file from Drive when it was asked for by id', async () => {
      const result = await harness.call('drive_download', { files: ['id:1'], local_path: root });
      expect(result.saved_to).toBe(join(root, 'a.txt'));
    });

    it('reports a task that fails, and writes nothing', async () => {
      fake.on(TASKS, 'get', () => ({ status: 'finished', result: { errors: [{ code: 1003 }] } }));
      const { isError } = await harness.callRaw('drive_download', { files: ['/mydrive/a.txt', '/mydrive/b.txt'], local_path: root });
      expect(isError).toBe(true);
      expect(existsSync(join(root, 'drive.zip'))).toBe(false);
    });
  });

  it('accepts a team folder as File Station shows it, and still refuses all of it', async () => {
    await harness.call('drive_delete', { files: ['/Acme/Plans/a.txt'], confirm: true, wait_seconds: 0 });
    expect(fake.callsTo(FILES, 'delete')[0]!.params.files).toBe('["/team-folders/Acme/Plans/a.txt"]');
    const { isError, text } = await harness.callRaw('drive_delete', { files: ['/Acme'], confirm: true });
    expect(isError).toBe(true);
    expect(text).toContain('whole team folder');
  });

  it('applies protected paths however a Drive path is written', async () => {
    const guarded = await connect(fake, { protectedPaths: ['/Acme/Private', '/home/Drive/Keep'] });
    for (const file of ['/Acme/Private/a.txt', '/team-folders/Acme/Private/a.txt', '/mydrive/Keep/a.txt', '/home/Drive/Keep/a.txt']) {
      const { isError, text } = await guarded.callRaw('drive_delete', { files: [file], confirm: true });
      expect(isError, file).toBe(true);
      expect(text, file).toContain('protected');
    }
    expect(fake.callsTo(FILES, 'delete')).toHaveLength(0);
    await guarded.close();
  });

  it('refuses a recycle bin however its path is written', async () => {
    const { isError, text } = await harness.callRaw('drive_delete', { files: ['/Acme/#recycle'], confirm: true });
    expect(isError).toBe(true);
    expect(text).toContain('recycle bin');
    expect(fake.callsTo(FILES, 'delete')).toHaveLength(0);
  });

  it('keeps a Drive-style protected path in force for File Station spellings too', () => {
    expect(() => assertNotProtected('/Acme/Private/a.txt', ['/team-folders/Acme/Private'])).toThrow(/protected/);
    expect(() => assertNotProtected('/home/Drive/Keep/a.txt', ['/mydrive/Keep'])).toThrow(/protected/);
    expect(() => assertNotProtected('/team-folders/Acme/x', ['/team-folders'])).toThrow(/protected/);
    expect(() => assertNotProtected('/team-folders/Acme/Public/a.txt', ['/Acme/Private'])).not.toThrow();
    expect(() => assertNotProtected('/mydrive/Other', ['/home/Drive/Keep'])).not.toThrow();
  });

  it('explains a generic Drive failure by pointing at the path', async () => {
    fake.on(FILES, 'list', () => {
      throw new DsmFailure(1000);
    });
    const { text } = await harness.callRaw('drive_list', { path: '/mydrive/x' });
    const { error } = JSON.parse(text);
    expect(error.code).toBe(1000);
    expect(error.message).not.toBe('DSM error 1000');
    expect(error.hint).toContain('/team-folders');
  });

  it('does not describe a download option that does not exist', async () => {
    const { tools } = await harness.mcp.listTools();
    const download = tools.find((t) => t.name === 'drive_download')!;
    expect(download.description).not.toContain('archive');
    expect(download.description).toContain('ZIP');
  });

  describe('drive_share', () => {
    it('lists and revokes at once, since neither exposes anything', async () => {
      await harness.call('drive_share', { path: '/mydrive/a.txt' });
      expect(fake.callsTo(SHARING, 'list')).toHaveLength(1);
      await harness.call('drive_share', { path: '/mydrive/a.txt', action: 'revoke', member: 'bob' });
      expect(fake.callsTo(SHARING, 'update')).toHaveLength(1);
    });

    it('previews a link and creates it only once confirmed', async () => {
      const preview = await harness.call('drive_share', { path: '/mydrive/a.txt', action: 'link' });
      expect(preview).toMatchObject({ confirm_required: true, would_create_link_for: '/mydrive/a.txt' });
      expect(fake.callsTo(SHARING, 'create_link')).toHaveLength(0);
      await expect(harness.call('drive_share', { path: '/mydrive/a.txt', action: 'link', confirm: true })).resolves.toMatchObject({ url: 'https://nas/d/s/abc' });
    });

    it('previews a grant with who gets what', async () => {
      const preview = await harness.call('drive_share', { path: '/mydrive/a.txt', action: 'grant', member: 'bob', role: 'editor' });
      expect(preview).toMatchObject({ confirm_required: true, would_grant: { member: 'bob', member_type: 'user', role: 'editor' } });
      expect(fake.callsTo(SHARING, 'update')).toHaveLength(0);
      await harness.call('drive_share', { path: '/mydrive/a.txt', action: 'grant', member: 'bob', role: 'editor', confirm: true });
      expect(fake.callsTo(SHARING, 'update')).toHaveLength(1);
    });

    it('checks the request before previewing it', async () => {
      expect((await harness.callRaw('drive_share', { path: '/mydrive/a.txt', action: 'grant', role: 'editor' })).isError).toBe(true);
      expect((await harness.callRaw('drive_share', { path: '/mydrive/a.txt', action: 'grant', member: 'bob' })).isError).toBe(true);
    });
  });

  describe('drive_requests', () => {
    const request = { path: '/mydrive/in', title: 'Send me files', password: 'hunter2' };

    it('previews a public upload link without showing its password, and creates it once confirmed', async () => {
      const preview = await harness.callRaw('drive_requests', { action: 'create', ...request });
      const parsed = JSON.parse(preview.text);
      expect(parsed).toMatchObject({ confirm_required: true, would_create: { folder: '/mydrive/in', title: 'Send me files', password_protected: true } });
      expect(preview.text).not.toContain('hunter2');
      expect(fake.callsTo(REQUESTS, 'create')).toHaveLength(0);
      await harness.call('drive_requests', { action: 'create', ...request, confirm: true });
      expect(fake.callsTo(REQUESTS, 'create')).toHaveLength(1);
    });

    it('previews an update too', async () => {
      const preview = await harness.call('drive_requests', { action: 'update', id: 'req1', path: '/mydrive/in', title: 'New' });
      expect(preview).toMatchObject({ confirm_required: true, would_update: { id: 'req1', password_protected: false } });
      expect(fake.callsTo(REQUESTS, 'update')).toHaveLength(0);
      await harness.call('drive_requests', { action: 'update', id: 'req1', path: '/mydrive/in', title: 'New', confirm: true });
      expect(fake.callsTo(REQUESTS, 'update')[0]!.params.sharing_link).toBe('"req1"');
    });

    it('lists at once, with passwords hidden', async () => {
      const { text } = await harness.callRaw('drive_requests', {});
      expect(text).not.toContain('hunter2');
    });
  });

  it('lists published operations and hides ones this NAS does not offer', async () => {
    const mail = await harness.call('suite_apis', { product: 'mail' });
    expect(mail.operations.find((op: { id: string }) => op.id === 'mail.Draft.send')).toMatchObject({ via: 'mail_send', not_on_this_nas: true });
    const drive = await harness.call('suite_apis', { product: 'drive' });
    expect(drive.operations.find((op: { id: string }) => op.id === 'drive.Files.search')).toMatchObject({ via: 'drive_search' });
    expect(await harness.toolNames()).not.toContain('mail_send');
    expect(await harness.toolNames()).toContain('drive_file');
  });

  it('lists and searches Drive with the published parameter names', async () => {
    const listed = await harness.call('drive_list', { path: '/mydrive', limit: 5 });
    expect(listed.files).toEqual([expect.objectContaining({ name: 'a.txt', path: '/mydrive/a.txt' })]);
    const list = fake.callsTo(FILES, 'list').at(-1)!;
    expect(list.version).toBe(11);
    expect(list.params.path).toBe('"/mydrive"');
    expect(list.params.sort_direction).toBe('"asc"');

    await harness.call('drive_search', { keyword: 'budget', path: '/mydrive' });
    const search = fake.callsTo(FILES, 'search').at(-1)!;
    expect(search.params).toMatchObject({ keyword: '"budget"', location: '"mydrive"' });
    expect(search.params.path).toBeUndefined();
  });

  it('previews a Drive delete, then sends it once confirmed', async () => {
    const preview = await harness.call('drive_delete', { files: ['/mydrive/a.txt'] });
    expect(preview).toMatchObject({ confirm_required: true, nothing_changed: true });
    expect(fake.callsTo(FILES, 'delete')).toHaveLength(0);

    const done = await harness.call('drive_delete', { files: ['/mydrive/a.txt'], confirm: true, wait_seconds: 0 });
    expect(done).toMatchObject({ status: 'still_running', task_id: 'task-1', permanent: false });
    expect(fake.callsTo(FILES, 'delete').at(-1)?.params.files).toBe('["/mydrive/a.txt"]');
  });

  it('refuses to delete a whole Drive root', async () => {
    const { isError, text } = await harness.callRaw('drive_delete', { files: ['/mydrive'], confirm: true });
    expect(isError).toBe(true);
    expect(text).toContain('shared folder');
    expect(fake.callsTo(FILES, 'delete')).toHaveLength(0);
  });

  it('runs a read through suite_read and holds a write for confirmation', async () => {
    const read = await harness.call('suite_read', { operation: 'drive.Files.get', params: { path: '/mydrive/a.txt' } });
    expect(read).toMatchObject({ name: 'a.txt' });

    const refused = await harness.callRaw('suite_read', { operation: 'drive.Files.request_access', params: { path: '/mydrive/a.txt' } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('suite_call');

    const preview = await harness.call('suite_call', { operation: 'drive.Files.request_access', params: { path: '/mydrive/a.txt' } });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo(FILES, 'request_access')).toHaveLength(0);
    await harness.call('suite_call', { operation: 'drive.Files.request_access', params: { path: '/mydrive/a.txt' }, confirm: true });
    expect(fake.callsTo(FILES, 'request_access')).toHaveLength(1);
  });

  it('sends spreadsheet operations to the sheet tools', async () => {
    const { isError, text } = await harness.callRaw('suite_call', { operation: 'spreadsheet.get.spreadsheets', confirm: true });
    expect(isError).toBe(true);
    expect(text).toContain('sheet_info');
  });
});

describe('MailPlus and Calendar calls', () => {
  let fake: FakeDsm;
  let harness: Harness;

  beforeEach(async () => {
    fake = withVersions(
      new FakeDsm()
        .on('SYNO.MailClient.Draft', 'send', () => ({ id: 9 }))
        .on('SYNO.MailClient.Filter', 'create', () => ({ id: 5 }))
        .on('SYNO.MailClient.Filter', 'set', () => ({}))
        .on('SYNO.MailClient.Mailbox', 'list', () => ({ total: 1, mailbox: [{ id: -1, name: 'Inbox', path: 'Inbox' }] }))
        .on('SYNO.Cal.Event', 'create', () => ({ evt_id: 3, summary: 'Meet', cal_id: '/home/', dtstart: 1_700_000_000, dtend: 1_700_003_600 }))
        .on('SYNO.Cal.Event', 'delete', () => ({})),
    );
    await fake.start();
    harness = await connect(fake);
  });

  afterEach(async () => {
    await harness?.close();
    await fake?.stop();
  });

  it('previews an email with everything that would go out, and sends only once confirmed', async () => {
    const boxes = await harness.call('mail_mailboxes');
    expect(boxes.mailboxes).toEqual([expect.objectContaining({ id: -1, name: 'Inbox' })]);
    const preview = await harness.call('mail_send', { to: ['a@example.com'], cc: ['b@example.com'], subject: 'Hi', body: 'There' });
    expect(preview).toMatchObject({ confirm_required: true, nothing_changed: true, to: ['a@example.com'], cc: ['b@example.com'], subject: 'Hi', body_preview: 'There' });
    expect(fake.callsTo('SYNO.MailClient.Draft', 'send')).toHaveLength(0);
    const sent = await harness.call('mail_send', { to: ['a@example.com'], subject: 'Hi', body: 'There', confirm: true });
    expect(sent).toEqual({ sent: true, id: 9 });
    const call = fake.callsTo('SYNO.MailClient.Draft', 'send').at(-1)!;
    expect(call.version).toBe(6);
    expect(call.params.to).toBe('["a@example.com"]');
    expect(call.params.subject).toBe('"Hi"');
    expect(call.params.is_plain).toBe('true');
  });

  it('shows only the start of a long email in the preview', async () => {
    const preview = await harness.call('mail_send', { to: ['a@example.com'], body: 'x'.repeat(5_000) });
    expect(preview.body_preview.length).toBeLessThan(600);
    expect(preview.body_length).toBe(5_000);
  });

  it('will not set up forwarding without confirmation, since it keeps sending mail out', async () => {
    const forward = { conditions: [{ name: 'from', value: 'boss@example.com' }], actions: [{ name: 'forward', value: 'someone@example.net' }] };
    const preview = await harness.call('mail_filter', { action: 'create', ...forward });
    expect(preview.confirm_required).toBe(true);
    expect(preview.warning).toContain('someone@example.net');
    expect(fake.callsTo('SYNO.MailClient.Filter', 'create')).toHaveLength(0);
    await harness.call('mail_filter', { action: 'create', ...forward, confirm: true });
    expect(fake.callsTo('SYNO.MailClient.Filter', 'create')).toHaveLength(1);
  });

  it('also asks before a filter is applied to existing mail, and before changing one to forward', async () => {
    const label = { conditions: [{ name: 'from', value: 'a' }], actions: [{ name: 'setstar', value: '1' }] };
    expect((await harness.call('mail_filter', { action: 'create', ...label, apply_to_existing: true })).confirm_required).toBe(true);
    expect((await harness.call('mail_filter', { action: 'update', id: 1, conditions: label.conditions, actions: [{ name: 'FORWARD', value: 'x@example.net' }] })).confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.MailClient.Filter', 'create')).toHaveLength(0);
    expect(fake.callsTo('SYNO.MailClient.Filter', 'set')).toHaveLength(0);
  });

  it('does not ask for a filter that only organizes new mail', async () => {
    const result = await harness.call('mail_filter', { action: 'create', conditions: [{ name: 'from', value: 'a' }], actions: [{ name: 'setstar', value: '1' }] });
    expect(result.confirm_required).toBeUndefined();
    expect(fake.callsTo('SYNO.MailClient.Filter', 'create')).toHaveLength(1);
  });

  it('creates an event with the published fields and previews a delete', async () => {
    const created = await harness.call('calendar_event', {
      action: 'create',
      calendar: '/home/',
      title: 'Meet',
      start: '2026-11-02T09:00:00Z',
      end: '2026-11-02T10:00:00Z',
    });
    expect(created).toMatchObject({ id: 3, title: 'Meet' });
    const call = fake.callsTo('SYNO.Cal.Event', 'create').at(-1)!;
    expect(call.version).toBe(5);
    expect(JSON.parse(call.params.summary!)).toBe('Meet');
    expect(JSON.parse(call.params.cal_id!)).toBe('/home/');
    expect(call.params.is_repeat_evt).toBe('false');
    expect(call.params.notify_setting).toBe('[]');

    const preview = await harness.call('calendar_event', { action: 'delete', id: 3 });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Cal.Event', 'delete')).toHaveLength(0);
    await harness.call('calendar_event', { action: 'delete', id: 3, confirm: true });
    expect(fake.callsTo('SYNO.Cal.Event', 'delete').at(-1)?.params.evt_id).toBe('3');
  });
});
