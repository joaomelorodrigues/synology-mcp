import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDsm } from './fake-dsm.js';
import { connect, type Harness } from './helpers.js';

const ITEM = 'SYNO.Foto.Browse.Item';
const TEAM_ITEM = 'SYNO.FotoTeam.Browse.Item';
const THUMB = 'SYNO.Foto.Thumbnail';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const PHOTO = {
  id: 7,
  filename: 'IMG_1.jpg',
  filesize: 2048,
  time: 1687686880,
  folder_id: 3,
  owner_user_id: 1,
  type: 'photo',
  additional: {
    resolution: { width: 4000, height: 3000 },
    description: 'Sunset',
    exif: { camera: 'iPhone 11', lens: 'Back camera', aperture: 'F1.8', exposure_time: '1/120', focal_length: '4.2', iso: '32' },
    gps: { latitude: 38.7, longitude: -9.1 },
    address: { landmark: '', route: 'Rua A', district: '', city: 'Lisboa', county: 'Lisboa', state: 'Lisboa', country: 'Portugal' },
    tag: [{ id: 1, name: 'beach' }],
    person: [{ id: 2, name: 'Ana' }, { id: 3, name: '' }],
    thumbnail: { cache_key: '7_1687686880', sm: 'ready', m: 'ready', xl: 'broken', preview: 'broken' },
  },
};

describe('Photos tools', () => {
  let fake: FakeDsm;
  let harness: Harness;
  let root: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'photos-')));
    fake = new FakeDsm()
      .on(ITEM, 'list', () => ({ list: [PHOTO] }))
      .on(ITEM, 'list_with_filter', () => ({ list: [PHOTO] }))
      .on(ITEM, 'get', () => ({ list: [PHOTO] }))
      .on(TEAM_ITEM, 'get', () => ({ list: [] }))
      .onRaw(THUMB, 'get', (res) => {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(JPEG);
      })
      .onRaw('SYNO.Foto.Download', 'download', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('original');
      });
    await fake.start();
    harness = await connect(fake, { localRoots: [root] });
  });

  afterEach(async () => {
    await harness.close();
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  describe('photos_items', () => {
    it('filters by when a photo was taken and by rating', async () => {
      const result = await harness.call('photos_items', { taken_from: '2023-06-01', taken_to: '2023-06-30T23:59:59Z', rating: [4, 5] });
      expect(result.items[0]).toMatchObject({ id: 7, filename: 'IMG_1.jpg', taken: '2023-06-25T09:54:40Z' });
      const call = fake.callsTo(ITEM, 'list_with_filter')[0]!;
      expect(JSON.parse(call.params.time!)).toEqual([{ start_time: Date.parse('2023-06-01') / 1000, end_time: Date.parse('2023-06-30T23:59:59Z') / 1000 }]);
      expect(call.params.rating).toBe('[4,5]');
    });

    it('combines filters with a person, and leaves the date open at either end', async () => {
      await harness.call('photos_items', { person_id: 2, taken_from: '2023-06-01' });
      const call = fake.callsTo(ITEM, 'list_with_filter')[0]!;
      expect(call.params.person).toBe('[2]');
      const [range] = JSON.parse(call.params.time!);
      expect(range.start_time).toBe(Date.parse('2023-06-01') / 1000);
      expect(range.end_time).toBeGreaterThan(Date.now() / 1000);
    });

    it('says plainly that dates and ratings do not narrow an album or folder', async () => {
      const { isError, text } = await harness.callRaw('photos_items', { album_id: 1, rating: [5] });
      expect(isError).toBe(true);
      expect(text).toContain('album_id');
      expect(fake.callsTo(ITEM, 'list')).toHaveLength(0);
    });

    it('refuses a date it cannot read', async () => {
      const { isError, text } = await harness.callRaw('photos_items', { taken_from: 'last summer' });
      expect(isError).toBe(true);
      expect(text).toContain('not a time');
    });
  });

  describe('photos_info', () => {
    it('gives camera, place, people and tags of one item', async () => {
      const result = await harness.call('photos_info', { id: 7 });
      expect(result).toMatchObject({
        id: 7,
        width: 4000,
        description: 'Sunset',
        camera: 'iPhone 11',
        aperture: 'F1.8',
        gps: { latitude: 38.7, longitude: -9.1 },
        place: 'Rua A, Lisboa, Portugal',
        tags: ['beach'],
        people: ['Ana', 'person 3'],
        thumbnails: ['sm', 'm'],
      });
      const additional = JSON.parse(fake.callsTo(ITEM, 'get')[0]!.params.additional!);
      expect(additional).toEqual(expect.arrayContaining(['exif', 'gps', 'address', 'tag', 'person', 'description', 'thumbnail']));
    });

    it('says when an id belongs to the other space', async () => {
      const { isError, text } = await harness.callRaw('photos_info', { id: 7, space: 'shared' });
      expect(isError).toBe(true);
      expect(text).toContain('IDs belong to one space');
    });
  });

  describe('photos_thumbnail', () => {
    it('returns the picture itself, so the model can look at it', async () => {
      const result = await harness.mcp.callTool({ name: 'photos_thumbnail', arguments: { id: 7 } });
      const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(content[0]!.text!)).toMatchObject({ id: 7, filename: 'IMG_1.jpg', size: 'm' });
      expect(content[1]).toEqual({ type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' });
      expect(fake.callsTo(THUMB, 'get')[0]!.params).toMatchObject({ id: '7', cache_key: '"7_1687686880"', type: '"unit"', size: '"m"' });
    });

    it('names the sizes that exist when the one asked for does not', async () => {
      const { isError, text } = await harness.callRaw('photos_thumbnail', { id: 7, size: 'xl' });
      expect(isError).toBe(true);
      expect(text).toContain('sm, m');
      expect(fake.callsTo(THUMB, 'get')).toHaveLength(0);
    });

    it('refuses a reply that is not an image', async () => {
      fake.onRaw(THUMB, 'get', (res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('not an image');
      });
      const { isError, text } = await harness.callRaw('photos_thumbnail', { id: 7 });
      expect(isError).toBe(true);
      expect(text).toContain('not an image');
    });
  });

  it('still downloads the original under its own name', async () => {
    const result = await harness.call('photos_download', { id: 7, local_folder: root });
    expect(result.saved_to).toBe(join(root, 'IMG_1.jpg'));
    expect(readFileSync(join(root, 'IMG_1.jpg'), 'utf8')).toBe('original');
  });
});
