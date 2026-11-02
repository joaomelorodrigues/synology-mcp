import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUITE_OPS } from '../src/suite/catalog.js';
import { calendarTools, driveApiTools, mailTools, suiteMetaTools } from '../src/tools/suite.js';
import { FakeDsm } from './fake-dsm.js';
import { connect, type Harness } from './helpers.js';

const FILES = 'SYNO.SynologyDrive.Files';

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

  beforeEach(async () => {
    fake = withVersions(
      new FakeDsm()
        .on(FILES, 'list', () => ({ total: 1, items: [{ name: 'a.txt', file_id: '1', display_path: '/mydrive/a.txt', size: 4 }] }))
        .on(FILES, 'search', () => ({ total: 0, items: [] }))
        .on(FILES, 'get', () => ({ name: 'a.txt', file_id: '1', display_path: '/mydrive/a.txt', permanent_link: 'LINK' }))
        .on(FILES, 'delete', () => ({ async_task_id: 'task-1' }))
        .on(FILES, 'request_access', () => ({})),
    );
    await fake.start();
    harness = await connect(fake);
  });

  afterEach(async () => {
    await harness?.close();
    await fake?.stop();
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
    expect(done).toMatchObject({ status: 'accepted', task_id: 'task-1', permanent: false });
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

  it('sends mail and lists mailboxes', async () => {
    const boxes = await harness.call('mail_mailboxes');
    expect(boxes.mailboxes).toEqual([expect.objectContaining({ id: -1, name: 'Inbox' })]);
    const sent = await harness.call('mail_send', { to: ['a@example.com'], subject: 'Hi', body: 'There' });
    expect(sent).toEqual({ sent: true, id: 9 });
    const call = fake.callsTo('SYNO.MailClient.Draft', 'send').at(-1)!;
    expect(call.version).toBe(6);
    expect(call.params.to).toBe('["a@example.com"]');
    expect(call.params.subject).toBe('"Hi"');
    expect(call.params.is_plain).toBe('true');
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
    expect(JSON.parse(call.params.summary)).toBe('Meet');
    expect(JSON.parse(call.params.cal_id)).toBe('/home/');
    expect(call.params.is_repeat_evt).toBe('false');
    expect(call.params.notify_setting).toBe('[]');

    const preview = await harness.call('calendar_event', { action: 'delete', id: 3 });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Cal.Event', 'delete')).toHaveLength(0);
    await harness.call('calendar_event', { action: 'delete', id: 3, confirm: true });
    expect(fake.callsTo('SYNO.Cal.Event', 'delete').at(-1)?.params.evt_id).toBe('3');
  });
});
