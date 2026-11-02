import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { officePath } from '../src/tools/office.js';
import { expandRange } from '../src/tools/sheets.js';
import { DsmFailure, FakeDsm } from './fake-dsm.js';
import { connect, type Harness } from './helpers.js';

const NODE = 'SYNO.Office.Node';
const EXPORT = 'SYNO.Office.Export';
const FILES = 'SYNO.SynologyDrive.Files';
const TASKS = 'SYNO.SynologyDrive.Tasks';

const SHEET = { object_id: 'obj1', link_id: 'LINK123', title: 'Budget.osheet', ntype: 'sheet' };
const DOC = { object_id: 'obj2', link_id: 'DOC456', title: 'Notes.odoc', ntype: 'doc' };

function office(): FakeDsm {
  return new FakeDsm()
    .on(NODE, 'get', (params) => (params.path?.includes('DOC456') ? DOC : SHEET))
    .on('SYNO.Office.Info', 'get', () => ({ version: '3.7.2' }))
    .on('SYNO.Office.Locale', 'list', () => ({ locales: ['pt_PT'] }))
    .on('SYNO.Office.File', 'extract', () => ({ data: '  hello world  ' }))
    .on('SYNO.Office.Snapshot', 'create', () => ({}))
    .on('SYNO.Office.Snapshot', 'get', () => ({ object_id: 'obj2', content: { blocks: [] } }))
    .on('SYNO.Office.Sheet.Snapshot', 'get', () => ({ sheets: ['sh_1'] }))
    .on('SYNO.Office.Sheet.Snapshot.History', 'get', () => ({ sheets: ['old'] }))
    .on('SYNO.Office.Node.Version', 'list', () => ({ total: 1, versions: [{ version: 7, ver_name: 'v1', mtime: 1_700_000_000, author: { name: 'bob' }, editors: [{ name: 'ana' }], last_version: true }] }))
    .on('SYNO.Office.Node.Version', 'restore', () => ({}))
    .on('SYNO.Office.Node.Version', 'rename', () => ({}))
    .on('SYNO.Office.Node.Attachment', 'create', () => ({ files: [{ file_id: 'f1' }] }))
    .on('SYNO.Office.Setting', 'set', () => ({}))
    .on('SYNO.Office.Setting.UI', 'set', () => ({}))
    .on('SYNO.Office.Dictionary', 'set', () => ({}))
    .on('SYNO.Office.Theme', 'list', () => ({ themes: [] }))
    .on('SYNO.Office.Template', 'list', () => ({ templates: [] }))
    .on('SYNO.Office.Template', 'delete', () => ({}))
    .on('SYNO.Office.Node.Encrypt', 'check', () => ({}))
    .on('SYNO.Office.Sheet.MruFc', 'create', () => ({}))
    .on(FILES, 'convert_office', () => ({}))
    .on(TASKS, 'get', () => ({}))
    .onRaw(EXPORT, 'download', (res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('xlsx-bytes');
    });
}

describe('addressing Office files', () => {
  it.each([
    ['/mydrive/Budget.osheet', '/mydrive/Budget.osheet'],
    ['link:LINK123', 'link:LINK123'],
    ['id:42', 'id:42'],
    ['42', 'id:42'],
    ['LINK123', 'link:LINK123'],
    ['https://nas.example.com:5001/oo/r/LINK123#tid=1', 'link:LINK123'],
  ])('reads %s as %s', (input, expected) => {
    expect(officePath(input)).toBe(expected);
  });

  it('refuses what is none of those', () => {
    expect(() => officePath('../etc/passwd')).toThrow(/not a Drive path/);
  });
});

describe('Office tools over DSM', () => {
  let fake: FakeDsm;
  let harness: Harness;

  beforeEach(async () => {
    fake = await office().start();
    harness = await connect(fake);
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
  });

  it('gives details and a URL to open the file, JSON-quoting values as the client does', async () => {
    const result = await harness.call('office_file', { file: 'LINK123' });
    expect(result).toMatchObject({ title: 'Budget.osheet', link_id: 'LINK123', open_url: `${fake.url}/oo/r/LINK123` });
    const params = fake.callsTo(NODE, 'get')[0]!.params;
    expect(params.path).toBe('"link:LINK123"');
    expect(params.basic).toBe('true');
  });

  it('reads a spreadsheet as text with no snapshot, and pages it', async () => {
    const first = await harness.call('office_read_text', { file: 'LINK123' });
    expect(first).toMatchObject({ title: 'Budget.osheet', content: 'hello world', length: 11 });
    expect(fake.callsTo('SYNO.Office.File', 'extract')[0]!.params.link_id).toBe('"LINK123"');
    expect(fake.callsTo('SYNO.Office.Snapshot', 'create')).toHaveLength(0);
    const later = await harness.call('office_read_text', { file: 'LINK123', offset: 6 });
    expect(later.content).toBe('world');
  });

  it('refreshes the snapshot of a document first, as the client does, and reads on if that fails', async () => {
    await harness.call('office_read_text', { file: 'DOC456' });
    const create = fake.callsTo('SYNO.Office.Snapshot', 'create')[0]!;
    expect(create.version).toBe(2);
    expect(create.params.link_id).toBe('"DOC456"');
    fake.on('SYNO.Office.Snapshot', 'create', () => {
      throw new DsmFailure(117);
    });
    await expect(harness.call('office_read_text', { file: 'DOC456' })).resolves.toMatchObject({ content: 'hello world' });
  });

  it('reads the full structure by the right API for each type and version', async () => {
    await expect(harness.call('office_snapshot', { file: 'LINK123' })).resolves.toEqual({ sheets: ['sh_1'] });
    await expect(harness.call('office_snapshot', { file: 'LINK123', version: 3 })).resolves.toEqual({ sheets: ['old'] });
    expect(fake.callsTo('SYNO.Office.Sheet.Snapshot.History', 'get')[0]!.params).toMatchObject({ object_id: '"obj1"', ver: '3' });
    await expect(harness.call('office_snapshot', { file: 'DOC456' })).resolves.toMatchObject({ content: { blocks: [] } });
    expect(fake.callsTo('SYNO.Office.Snapshot', 'get')[0]!.version).toBe(3);
    expect((await harness.callRaw('office_snapshot', { file: 'DOC456', version: 1 })).isError).toBe(true);
  });

  it('lists versions in readable form', async () => {
    const result = await harness.call('office_versions', { file: 'LINK123' });
    expect(result.versions[0]).toEqual({ version: 7, name: 'v1', author: 'bob', modified: '2023-11-14T22:13:20Z', editors: ['ana'], current: true });
    expect(JSON.parse(fake.callsTo('SYNO.Office.Node.Version', 'list')[0]!.params.additional!)).toMatchObject({ name: true });
  });

  it('looks up reference data by kind, and asks for what a kind needs', async () => {
    await expect(harness.call('office_lookup', { kind: 'locales' })).resolves.toEqual({ locales: ['pt_PT'] });
    await harness.call('office_lookup', { kind: 'themes', type: 'doc' });
    expect(fake.callsTo('SYNO.Office.Theme', 'list')[0]!.params.ntype).toBe('"doc"');
    expect((await harness.callRaw('office_lookup', { kind: 'locale' })).text).toContain('needs value');
    expect((await harness.callRaw('office_lookup', { kind: 'ui_settings' })).text).toContain('needs file');
  });

  it('turns the encrypted-document code into advice', async () => {
    fake.on('SYNO.Office.Node.Version', 'list', () => {
      throw new DsmFailure(57373);
    });
    const { isError, text } = await harness.callRaw('office_versions', { file: 'LINK123' });
    expect(isError).toBe(true);
    expect(JSON.parse(text).error).toMatchObject({ code: 57373, hint: 'Pass password.' });
  });

  it('creates a file in Drive with the parameters the client sends', async () => {
    fake.on(NODE, 'create', () => ({ object_id: 'o9', link_id: 'NEW999', title: 'Plan.osheet' }));
    const result = await harness.call('office_create', { type: 'sheet', title: 'Plan' });
    expect(result).toEqual({ title: 'Plan.osheet', link_id: 'NEW999', object_id: 'o9', open_url: `${fake.url}/oo/r/NEW999` });
    const params = fake.callsTo(NODE, 'create')[0]!.params;
    expect(params).toMatchObject({ ntype: '"sheet"', path: '"/mydrive"', title: '"Plan"', encrypt: 'false', commit_msg: '{"device":"desktop"}' });
  });

  describe('importing', () => {
    beforeEach(() => {
      fake.on(FILES, 'convert_office', () => ({ async_task_id: 'task-1' }));
    });

    it('converts through Drive and waits for the task', async () => {
      let polls = 0;
      fake.on(TASKS, 'get', () => (++polls < 2 ? { status: 'running' } : { status: 'finished', result: { items: [{ name: 'data.osheet' }] } }));
      const result = await harness.call('office_import', { files: ['/mydrive/data.csv'], to_folder: 'id:7' });
      expect(result.status).toBe('done');
      expect(result.result.items[0].name).toBe('data.osheet');
      const call = fake.callsTo(FILES, 'convert_office')[0]!;
      expect(call.version).toBe(6);
      expect(JSON.parse(call.params.files!)).toEqual([{ path: '/mydrive/data.csv' }]);
      expect(call.params).toMatchObject({ conflict_action: '"autorename"', to_parent_folder: '"id:7"' });
      expect(fake.callsTo(TASKS, 'get')[0]!.params.task_id).toBe('"task-1"');
    });

    it('reports failures DSM only mentions in the finished task', async () => {
      fake.on(TASKS, 'get', () => ({ status: 'finished', result: { errors: [{ code: 57373, path: '/mydrive/locked.xlsx' }] } }));
      const { isError, text } = await harness.callRaw('office_import', { files: ['/mydrive/locked.xlsx'] });
      expect(isError).toBe(true);
      expect(text).toContain('locked.xlsx');
    });

    it('hands off a slow conversion instead of failing it', async () => {
      fake.on(TASKS, 'get', () => ({ status: 'running' }));
      const result = await harness.call('office_import', { files: ['/mydrive/big.xlsx'], wait_seconds: 1 });
      expect(result).toMatchObject({ status: 'still_running', task_id: 'task-1' });
    });
  });

  it('asks before setting a new password or restoring a version', async () => {
    fake.on(NODE, 'set', () => ({}));
    await harness.call('office_update', { file: 'LINK123', title: 'Renamed' });
    expect(fake.callsTo(NODE, 'set')).toHaveLength(1);
    const preview = await harness.call('office_update', { file: 'LINK123', new_password: 'x' });
    expect(preview.confirm_required).toBe(true);
    expect(fake.callsTo(NODE, 'set')).toHaveLength(1);
    expect((await harness.callRaw('office_update', { file: 'LINK123' })).isError).toBe(true);

    const restore = await harness.call('office_version_action', { file: 'LINK123', version: 3, action: 'restore' });
    expect(restore.confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Office.Node.Version', 'restore')).toHaveLength(0);
    await harness.call('office_version_action', { file: 'LINK123', version: 3, action: 'restore', confirm: true });
    expect(fake.callsTo('SYNO.Office.Node.Version', 'restore')).toHaveLength(1);
    await harness.call('office_version_action', { file: 'LINK123', version: 3, action: 'rename', name: 'Final' });
    expect(fake.callsTo('SYNO.Office.Node.Version', 'rename')[0]!.params.ver_name).toBe('"Final"');
  });

  it('refuses settings Synology does not have, and sends the ones it does', async () => {
    const wrong = await harness.callRaw('office_settings_set', { kind: 'settings', values: { nonsense: 1 } });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('default_locale');
    expect(fake.callsTo('SYNO.Office.Setting', 'set')).toHaveLength(0);
    await harness.call('office_settings_set', { kind: 'settings', values: { default_locale: 'pt_PT' } });
    expect(fake.callsTo('SYNO.Office.Setting', 'set')[0]!.params.default_locale).toBe('"pt_PT"');
    await harness.call('office_settings_set', { kind: 'ui_settings', file: 'LINK123', values: { zoom_level: 120 } });
    expect(fake.callsTo('SYNO.Office.Setting.UI', 'set')[0]!.params).toMatchObject({ object_id: '"obj1"', zoom_level: '120' });
    expect((await harness.callRaw('office_settings_set', { kind: 'ui_settings', values: { zoom_level: 1 } })).text).toContain('needs file');
    await harness.call('office_settings_set', { kind: 'dictionary', values: { add_words: ['NAS'] } });
    expect(fake.callsTo('SYNO.Office.Dictionary', 'set')[0]!.params.add_words).toBe('["NAS"]');
  });

  it('deletes a template only after confirmation', async () => {
    expect((await harness.call('office_template_action', { action: 'delete', id: 't1' })).confirm_required).toBe(true);
    expect(fake.callsTo('SYNO.Office.Template', 'delete')).toHaveLength(0);
    await harness.call('office_template_action', { action: 'delete', id: 't1', confirm: true });
    expect(fake.callsTo('SYNO.Office.Template', 'delete')[0]!.params.object_id).toBe('"t1"');
  });

  describe('APIs that DSM does not list', () => {
    it('reaches them through entry.cgi, since the client uses them', async () => {
      fake.on('SYNO.Office.Sheet.Snapshot.Worksheet', 'copy_new', () => ({ object_id: 'o3', link_id: 'COPY3', title: 'Tab' }));
      fake.on('SYNO.Office.Doc.Outline', 'get', () => ({ outline: [] }));
      delete fake.catalog['SYNO.Office.Sheet.Snapshot.Worksheet'];
      delete fake.catalog['SYNO.Office.Doc.Outline'];
      await harness.client.catalog({ refresh: true });
      const copied = await harness.call('office_sheet_copy', { file: 'LINK123', sheet_id: 'sh_2', title: 'Tab' });
      expect(copied.link_id).toBe('COPY3');
      expect(fake.callsTo('SYNO.Office.Sheet.Snapshot.Worksheet', 'copy_new')[0]!.params).toMatchObject({ sheet_id: '"sh_2"', path: '"/mydrive"' });
      await expect(harness.call('office_lookup', { kind: 'doc_outline', file: 'DOC456' })).resolves.toEqual({ outline: [] });
    });

    it('still says when one is really absent', async () => {
      const { isError, text } = await harness.callRaw('office_lookup', { kind: 'doc_outline', file: 'DOC456' });
      expect(isError).toBe(true);
      expect(JSON.parse(text).error.code).toBe(103);
    });
  });

  describe('office_call', () => {
    it('runs read methods at once and previews the others until confirmed', async () => {
      fake.on('SYNO.Office.Node.Encrypt', 'check', () => ({ ok: true, password: 'leak' }));
      fake.on('SYNO.Office.Sheet.MruFc', 'create', () => ({ saved: true }));
      const read = await harness.call('office_call', { api: 'SYNO.Office.Node.Encrypt', method: 'check', params: { path: 'link:A' } });
      expect(read).toEqual({ ok: true, password: '[redacted]' });
      expect(fake.callsTo('SYNO.Office.Node.Encrypt', 'check')[0]!.params.path).toBe('"link:A"');
      const preview = await harness.call('office_call', { api: 'SYNO.Office.Sheet.MruFc', method: 'create', params: { fc: 'SUM' } });
      expect(preview.confirm_required).toBe(true);
      expect(fake.callsTo('SYNO.Office.Sheet.MruFc', 'create')).toHaveLength(0);
      await expect(harness.call('office_call', { api: 'SYNO.Office.Sheet.MruFc', method: 'create', params: { fc: 'SUM' }, confirm: true })).resolves.toEqual({ saved: true });
    });

    it('reaches only Office APIs', async () => {
      const { isError, text } = await harness.callRaw('office_call', { api: 'SYNO.Core.System', method: 'reboot', confirm: true });
      expect(isError).toBe(true);
      expect(text).toContain('not an Office API');
    });
  });

  it('maps every API on the NAS, known or not', async () => {
    fake.on('SYNO.Office.Metrics', 'get', () => ({}));
    await harness.client.catalog({ refresh: true });
    const { apis } = await harness.call('office_apis');
    const find = (name: string) => apis.find((a: { api: string }) => a.api === name);
    expect(find('SYNO.Office.Node').methods).toContain('create(path,title,ntype');
    expect(find('SYNO.Office.Node').versions).toBe('1-9');
    expect(find('SYNO.Office.Metrics').methods).toContain('unknown');
    expect(find('SYNO.Office.Doc.Outline').not_listed_by_dsm).toBe(true);
  });
});

describe('files between the NAS and this computer', () => {
  let fake: FakeDsm;
  let harness: Harness;
  let root: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-')));
    fake = await office().start();
    harness = await connect(fake, { localRoots: [root] });
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('exports by POST, so a document password never reaches a URL, naming the file from its title', async () => {
    const result = await harness.call('office_export', { file: 'LINK123', local_path: root, password: 'hunter2' });
    expect(result).toMatchObject({ saved_to: join(root, 'Budget.xlsx'), format: 'xlsx' });
    expect(readFileSync(join(root, 'Budget.xlsx'), 'utf8')).toBe('xlsx-bytes');
    const call = fake.callsTo(EXPORT, 'download')[0]!;
    expect(call.url).toBe('/webapi/entry.cgi');
    expect(call.params).toMatchObject({ path: '"link:LINK123"', format: '"ms"', password: '"hunter2"' });
  });

  it('picks the open format extension for each type', async () => {
    await expect(harness.call('office_export', { file: 'DOC456', local_path: root, format: 'odf' })).resolves.toMatchObject({ saved_to: join(root, 'Notes.odt') });
  });

  it('will not replace a file unless asked, or write outside the allowed folders', async () => {
    writeFileSync(join(root, 'Budget.xlsx'), 'mine');
    const again = await harness.callRaw('office_export', { file: 'LINK123', local_path: root });
    expect(again.text).toContain('overwrite=true');
    expect(readFileSync(join(root, 'Budget.xlsx'), 'utf8')).toBe('mine');
    expect((await harness.callRaw('office_export', { file: 'LINK123', local_path: join(tmpdir(), 'elsewhere.xlsx') })).isError).toBe(true);
    expect(fake.callsTo(EXPORT)).toHaveLength(0);
  });

  it('attaches a local file the way the client does', async () => {
    writeFileSync(join(root, 'logo.png'), 'png-bytes');
    await harness.call('office_attachment_add', { file: 'LINK123', local_path: join(root, 'logo.png') });
    const call = fake.callsTo('SYNO.Office.Node.Attachment', 'create')[0]!;
    expect(call.file).toEqual({ name: 'logo.png', content: 'png-bytes' });
    expect(call.params.object_id).toBe('"obj1"');
    expect(JSON.parse(call.params.files!)).toEqual([{ type: 'raw', source: 'attachment' }]);
  });
});

describe('which Office tools a connection gets', () => {
  it('gives a read connection no way to change a document', async () => {
    const fake = await office().start();
    const harness = await connect(fake, { tier: 'read' });
    const { tools } = await harness.mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('office_read_text');
    expect(names).not.toContain('office_create');
    expect(names).not.toContain('office_call');
    expect(tools.find((t) => t.name === 'office_export')!.annotations?.readOnlyHint).toBe(false);
    await harness.close();
    await fake.stop();
  });

  it('hides them on a NAS without Synology Office', async () => {
    const fake = await new FakeDsm().start();
    const harness = await connect(fake);
    const names = await harness.toolNames();
    expect(names.filter((name) => name.startsWith('office_'))).toEqual([]);
    await harness.close();
    await fake.stop();
  });
});

describe('expandRange', () => {
  it.each([
    ['Sheet1!B2', [[1, 2, 3], [4]], 'Sheet1!B2:D3'],
    ['A1', [[1]], 'A1:A1'],
    ['z9', [[1, 2]], 'Z9:AA9'],
    ['AA1', [[1, 2]], 'AA1:AB1'],
    ['Sheet 1!A1', [[1], [2]], 'Sheet 1!A1:A2'],
    ['Sheet1!A1:C3', [[1]], 'Sheet1!A1:C3'],
  ])('%s with those values is %s', (range, values, expected) => {
    expect(expandRange(range, values as unknown[][])).toBe(expected);
  });
});

interface SpreadsheetRequest {
  method: string;
  url: string;
  auth?: string;
  body?: any;
}

describe('the Spreadsheet API container', () => {
  let fake: FakeDsm;
  let harness: Harness;
  let server: Server;
  let url: string;
  let requests: SpreadsheetRequest[];
  let validToken: string;
  let refuseLogin: boolean;
  let root: string;

  beforeEach(async () => {
    requests = [];
    validToken = 'jwt-1';
    refuseLogin = false;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sheets-')));
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString();
      const call: SpreadsheetRequest = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined };
      requests.push(call);
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/spreadsheets/authorize') {
        if (refuseLogin) return send(401, { message: 'Unauthorized' });
        return send(200, { token: validToken });
      }
      if (req.url === '/spreadsheets/authorize/token/revoke') return send(200, {});
      if (call.auth !== `Bearer ${validToken}`) return send(401, { message: 'token expired' });
      if (req.url === '/spreadsheets/LINK123') {
        return send(200, { id: 'LINK123', properties: { title: 'Budget', locale: 'pt_PT' }, sheets: [{ properties: { sheetId: 'sh_1', title: 'Sheet1', index: 0 }, rowCount: 100, colCount: 26, mergeCells: [[0, 0, 1, 1]] }] });
      }
      if (req.url?.includes('/values/') && req.method === 'GET') {
        return send(200, { range: 'Sheet1!A1:B1', values: [['plain', { t: 'r', v: [{ tx: 'rich ' }, { tx: 'text' }] }]] });
      }
      if (req.url?.endsWith('/append')) return send(200, { updates: { updateRows: 2, updateRange: 'Sheet1!A5:B6' } });
      if (req.url === '/spreadsheets/LINK123/sheet/add') return send(200, { addSheet: { properties: { sheetId: 'sh_2', index: 1 } } });
      if (req.url === '/spreadsheets/create') return send(200, { spreadsheetId: 'NEW1' });
      if (req.url === '/spreadsheets/MISSING') return send(404, { message: 'no such spreadsheet' });
      if (req.url === '/spreadsheets/LINK123/xlsx') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end('xlsx-bytes');
      }
      return send(200, {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake = await office().start();
    harness = await connect(fake, { spreadsheetApiUrl: url, spreadsheetDsmHost: 'dsm:5003', spreadsheetDsmProtocol: 'http', localRoots: [root] });
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const sent = (fragment: string): SpreadsheetRequest | undefined => requests.find((r) => r.url.includes(fragment));

  it('stays hidden until it is set up, and says how', async () => {
    const plain = await connect(fake);
    expect(await plain.toolNames()).not.toContain('sheet_write');
    const capabilities = await plain.call('nas_capabilities');
    expect(capabilities.hidden.config).toContain('sheet_write');
    expect(capabilities.hidden_detail.join()).toContain('spreadsheet-setup');
    await plain.close();
    expect(await harness.toolNames()).toContain('sheet_write');
  });

  it('logs in with the host the container should use, and reuses the token', async () => {
    await harness.call('sheet_info', { file: 'LINK123' });
    await harness.call('sheet_info', { file: 'LINK123' });
    const logins = requests.filter((r) => r.url === '/spreadsheets/authorize');
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ username: 'alice', password: 'secret', host: 'dsm:5003', protocol: 'http' });
    expect(sent('/spreadsheets/LINK123')!.auth).toBe('Bearer jwt-1');
  });

  it('resolves a Drive path to the spreadsheet id', async () => {
    const info = await harness.call('sheet_info', { file: '/mydrive/Budget.osheet' });
    expect(info).toMatchObject({ id: 'LINK123', title: 'Budget', locale: 'pt_PT' });
    expect(info.tabs[0]).toEqual({ sheet_id: 'sh_1', name: 'Sheet1', index: 0, rows: 100, columns: 26, merged: 1 });
    expect(fake.callsTo(NODE, 'get')[0]!.params.path).toBe('"/mydrive/Budget.osheet"');
  });

  it('collapses rich text when reading, and encodes the range', async () => {
    const result = await harness.call('sheet_read', { file: 'LINK123', range: 'My Tab!A1:B1' });
    expect(result.values).toEqual([['plain', 'rich text']]);
    expect(sent('/values/')!.url).toBe('/spreadsheets/LINK123/values/My%20Tab!A1%3AB1');
  });

  it('writes from a first cell, expanding it to the block', async () => {
    const result = await harness.call('sheet_write', { file: 'LINK123', range: 'Sheet1!B2', values: [[1, '=A1*2'], [true, null]] });
    expect(result.written).toBe('Sheet1!B2:C3');
    const call = sent('/values/')!;
    expect(call.method).toBe('PUT');
    expect(decodeURIComponent(call.url)).toBe('/spreadsheets/LINK123/values/Sheet1!B2:C3');
    expect(call.body).toEqual({ values: [[1, '=A1*2'], [true, null]] });
  });

  it('appends rows and formats cells in the shape the API takes', async () => {
    await expect(harness.call('sheet_append', { file: 'LINK123', range: 'Sheet1!A1', values: [[1], [2]] })).resolves.toEqual({ appended_rows: 2, range: 'Sheet1!A5:B6' });
    await harness.call('sheet_format', { file: 'LINK123', sheet: 'Sheet1', start_row: 0, start_column: 1, formats: [[{ bg: 'FF0000' }]] });
    expect(sent('/styles')!.body).toEqual({ sheetName: 'Sheet1', startRow: 0, startCol: 1, rows: [{ values: [{ userEnteredFormat: { bg: 'FF0000' } }] }] });
  });

  it('manages tabs, asking before deleting one', async () => {
    await expect(harness.call('sheet_tabs', { file: 'LINK123', action: 'add', name: 'Q2' })).resolves.toEqual({ added: 'Q2', sheet_id: 'sh_2', index: 1 });
    await harness.call('sheet_tabs', { file: 'LINK123', action: 'rename', sheet_id: 'sh_2', name: 'Q3' });
    expect(sent('/sheet/rename')!.body).toEqual({ sheetId: 'sh_2', sheetName: 'Q3' });
    expect((await harness.call('sheet_tabs', { file: 'LINK123', action: 'delete', sheet_id: 'sh_2' })).confirm_required).toBe(true);
    expect(sent('/sheet/delete')).toBeUndefined();
    await harness.call('sheet_tabs', { file: 'LINK123', action: 'delete', sheet_id: 'sh_2', confirm: true });
    expect(sent('/sheet/delete')!.body).toEqual({ sheetId: 'sh_2' });
  });

  it('inserts rows at once, and deletes them only after confirmation', async () => {
    await harness.call('sheet_dimensions', { file: 'LINK123', sheet_id: 'sh_1', action: 'insert', dimension: 'rows', start: 2, count: 3 });
    expect(sent('/batchUpdate')!.body).toEqual({ requests: [{ insertDimension: { range: { sheetId: 'sh_1', dimension: 'ROWS', startIndex: 2, endIndex: 5 }, inheritFromBefore: true } }] });
    requests.length = 0;
    expect((await harness.call('sheet_dimensions', { file: 'LINK123', sheet_id: 'sh_1', action: 'delete', dimension: 'columns', start: 0, count: 1 })).confirm_required).toBe(true);
    expect(sent('/batchUpdate')).toBeUndefined();
    await harness.call('sheet_dimensions', { file: 'LINK123', sheet_id: 'sh_1', action: 'delete', dimension: 'columns', start: 0, count: 1, confirm: true });
    expect(sent('/batchUpdate')!.body.requests[0].deleteDimension.range.dimension).toBe('COLUMNS');
  });

  it('previews deleting a whole spreadsheet with what would go', async () => {
    const preview = await harness.call('sheet_delete', { file: 'LINK123' });
    expect(preview).toMatchObject({ confirm_required: true, would_delete: 'Budget', tabs: 1 });
    expect(sent('/spreadsheets/delete')).toBeUndefined();
    await harness.call('sheet_delete', { file: 'LINK123', confirm: true });
    expect(sent('/spreadsheets/delete')!.body).toEqual({ spreadsheetId: 'LINK123' });
  });

  it('creates a spreadsheet and gives its URL', async () => {
    await expect(harness.call('sheet_create', { name: 'New' })).resolves.toEqual({ name: 'New', link_id: 'NEW1', open_url: `${fake.url}/oo/r/NEW1` });
  });

  it('exports inside the allowed folders only, and csv needs a tab', async () => {
    const result = await harness.call('sheet_export', { file: 'LINK123', local_path: join(root, 'out.xlsx') });
    expect(result.saved_to).toBe(join(root, 'out.xlsx'));
    expect(readFileSync(join(root, 'out.xlsx'), 'utf8')).toBe('xlsx-bytes');
    expect((await harness.callRaw('sheet_export', { file: 'LINK123', local_path: join(root, 'x.csv'), format: 'csv' })).text).toContain('needs sheet_id');
    expect((await harness.callRaw('sheet_export', { file: 'LINK123', local_path: join(tmpdir(), 'x.xlsx') })).isError).toBe(true);
  });

  it('gets a new token once when the old one expires', async () => {
    await harness.call('sheet_info', { file: 'LINK123' });
    validToken = 'jwt-2';
    const info = await harness.call('sheet_info', { file: 'LINK123' });
    expect(info.id).toBe('LINK123');
    expect(requests.filter((r) => r.url === '/spreadsheets/authorize')).toHaveLength(2);
  });

  it('never resends a refused login, and explains the likely causes', async () => {
    refuseLogin = true;
    const first = await harness.callRaw('sheet_info', { file: 'LINK123' });
    expect(first.isError).toBe(true);
    const error = JSON.parse(first.text).error;
    expect(error.kind).toBe('auth_failed');
    expect(error.hint).toContain('2FA');
    expect(error.hint).toContain('http://dsm:5003');
    await harness.callRaw('sheet_info', { file: 'LINK123' });
    expect(requests.filter((r) => r.url === '/spreadsheets/authorize')).toHaveLength(1);
    expect(first.text).not.toContain('secret');
  });

  it('reports what the API said on an error', async () => {
    const { isError, text } = await harness.callRaw('sheet_info', { file: 'MISSING' });
    expect(isError).toBe(true);
    expect(JSON.parse(text).error).toMatchObject({ kind: 'not_found' });
    expect(text).toContain('no such spreadsheet');
  });

  it('says when the container is down', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const { isError, text } = await harness.callRaw('sheet_write', { file: 'LINK123', range: 'A1', values: [[1]] });
    expect(isError).toBe(true);
    expect(JSON.parse(text).error).toMatchObject({ kind: 'unreachable' });
    expect(text).toContain('synology/spreadsheet-api');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('ends its DSM session on close', async () => {
    await harness.call('sheet_info', { file: 'LINK123' });
    await harness.close();
    expect(sent('/token/revoke')!.auth).toBe('Bearer jwt-1');
    harness = await connect(fake);
  });
});
