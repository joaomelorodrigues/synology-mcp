import { afterEach, describe, expect, it } from 'vitest';
import { CredentialProvider } from '../src/credentials.js';
import { DsmClient, encodeParams, isReadMethod, q } from '../src/dsm/client.js';
import { DsmError } from '../src/dsm/errors.js';
import { DsmFailure, FakeDsm, selfSignedCert } from './fake-dsm.js';
import { MemoryStore } from './helpers.js';

const INFO = 'SYNO.Test.Info';

function clientFor(fake: FakeDsm, secrets: { password?: string; deviceId?: string; username?: string } = {}, tls: { certFingerprint?: string; insecureTls?: boolean } = {}): DsmClient {
  return new DsmClient(
    { url: fake.url, timeoutMs: 3_000, deviceName: 'test', insecureTls: false, ...tls },
    {
      resolve: async () => ({
        username: secrets.username ?? 'alice',
        password: secrets.password ?? 'secret',
        deviceId: secrets.deviceId,
      }),
    },
    false,
  );
}

describe('DSM client', () => {
  let fake: FakeDsm;
  let client: DsmClient;

  afterEach(async () => {
    await client?.close();
    await fake?.stop();
  });

  async function setup(options: ConstructorParameters<typeof FakeDsm>[0] = {}, secrets: Parameters<typeof clientFor>[1] = {}): Promise<void> {
    fake = await new FakeDsm(options).start();
    client = clientFor(fake, secrets);
  }

  it('logs in by POST, so the password is never in a URL', async () => {
    await setup();
    fake.on(INFO, 'get', () => ({ ok: 1 }));
    await client.call(INFO, 'get');
    expect(fake.logins).toHaveLength(1);
    expect(fake.logins[0]!.passwd).toBe('secret');
    expect(fake.logins[0]!.enable_syno_token).toBe('yes');
    expect(fake.calls[0]!.url).not.toContain('secret');
    expect(fake.calls[0]!.url).toBe('/webapi/entry.cgi');
  });

  it('sends the session as a cookie with the CSRF token, never as _sid', async () => {
    await setup();
    fake.on(INFO, 'get', () => ({}));
    await client.call(INFO, 'get');
    const call = fake.calls[0]!;
    expect(call.cookie).toBe('sid-1');
    expect(call.token).toBe('token-sid-1');
    expect(call.params._sid).toBeUndefined();
  });

  it('shares one login among parallel first calls', async () => {
    await setup();
    fake.on(INFO, 'get', () => ({}));
    await Promise.all([client.call(INFO, 'get'), client.call(INFO, 'get'), client.call(INFO, 'get')]);
    expect(fake.logins).toHaveLength(1);
  });

  it('logs in again once when the session expires, and retries the call', async () => {
    await setup();
    let served = 0;
    fake.on(INFO, 'get', () => ({ served: ++served }));
    await client.call(INFO, 'get');
    fake.expireSessions();
    const data = await client.call(INFO, 'get');
    expect(data.served).toBe(2);
    expect(fake.logins).toHaveLength(2);
  });

  it('logs in only once when parallel calls all meet the same expired session', async () => {
    await setup();
    fake.on(INFO, 'get', () => ({ ok: true }));
    await client.call(INFO, 'get');
    fake.expireSessions();
    const replies = await Promise.all(Array.from({ length: 8 }, () => client.call(INFO, 'get')));
    expect(replies).toHaveLength(8);
    expect(fake.logins).toHaveLength(2);
  });

  it('logs in only once when a slow call meets an expiry another call already fixed', async () => {
    await setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.onRaw(INFO, 'slow', (res) => {
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 119 } }));
      });
    });
    fake.on(INFO, 'get', () => ({ ok: true }));
    await client.call(INFO, 'get');
    fake.onRaw(INFO, 'slow', (res, call) => {
      if (call.cookie === 'sid-2') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { retried: true } }));
        return;
      }
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 119 } }));
      });
    });
    const slow = client.call(INFO, 'slow', {}, { write: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.expireSessions();
    await client.call(INFO, 'get');
    expect(fake.logins).toHaveLength(2);
    release();
    await expect(slow).resolves.toEqual({ retried: true });
    expect(fake.logins).toHaveLength(2);
  });

  it('does not treat a permission error as a session problem', async () => {
    await setup();
    fake.on(INFO, 'get', () => {
      throw new DsmFailure(105);
    });
    await expect(client.call(INFO, 'get')).rejects.toMatchObject({ kind: 'permission_denied', code: 105 });
    expect(fake.logins).toHaveLength(1);
  });

  it('never resends credentials DSM refused, to stay clear of Auto Block', async () => {
    await setup({}, { password: 'wrong' });
    fake.on(INFO, 'get', () => ({}));
    await expect(client.call(INFO, 'get')).rejects.toMatchObject({ kind: 'auth_failed', code: 400 });
    await expect(client.call(INFO, 'get')).rejects.toMatchObject({ kind: 'auth_failed', code: 400 });
    await expect(client.call(INFO, 'get')).rejects.toMatchObject({ kind: 'auth_failed', code: 400 });
    expect(fake.logins).toHaveLength(1);
  });

  it('tries again once the stored credentials change', async () => {
    fake = await new FakeDsm().start();
    let password = 'wrong';
    client = new DsmClient({ url: fake.url, timeoutMs: 3_000, deviceName: 'test', insecureTls: false }, { resolve: async () => ({ username: 'alice', password }) }, false);
    fake.on(INFO, 'get', () => ({ ok: true }));
    await expect(client.call(INFO, 'get')).rejects.toBeInstanceOf(DsmError);
    password = 'secret';
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
    expect(fake.logins).toHaveLength(2);
  });

  it('logs in with a trusted-device token on a 2FA account', async () => {
    await setup({ otp: '123456' }, { deviceId: 'device-token-1' });
    fake.on(INFO, 'get', () => ({ ok: true }));
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
    expect(fake.logins[0]!.device_id).toBe('device-token-1');
    expect(fake.logins[0]!.device_name).toBe('test');
  });

  it('says how to fix a refused device token, and remembers the refusal', async () => {
    await setup({ otp: '123456' }, { deviceId: 'stale-token' });
    fake.on(INFO, 'get', () => ({}));
    const error = (await client.call(INFO, 'get').catch((e) => e)) as DsmError;
    expect(error.code).toBe(403);
    expect(error.hint).toContain('nas_auth_otp');
    await client.call(INFO, 'get').catch(() => undefined);
    expect(fake.logins).toHaveLength(1);
  });

  it('gets a device token from an OTP login, and that clears an earlier refusal', async () => {
    await setup({ otp: '123456' });
    fake.on(INFO, 'get', () => ({ ok: true }));
    await client.call(INFO, 'get').catch(() => undefined);
    const result = await client.login({ otpCode: '123456', requestDeviceToken: true });
    expect(result.deviceToken).toBe('device-token-1');
    expect(fake.logins.at(-1)!.enable_device_token).toBe('yes');
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
  });

  it('does not remember a mistyped OTP against the stored credentials', async () => {
    await setup({ otp: '123456' });
    await expect(client.login({ otpCode: '000000', requestDeviceToken: true })).rejects.toMatchObject({ code: 404 });
    await expect(client.login({ otpCode: '123456', requestDeviceToken: true })).resolves.toMatchObject({ deviceToken: 'device-token-1' });
  });

  it('clamps versions to what the NAS offers', async () => {
    await setup({ catalog: { [INFO]: { minVersion: 2, maxVersion: 5 } } });
    fake.on(INFO, 'get', () => ({}));
    await client.call(INFO, 'get', {}, { version: 9 });
    await client.call(INFO, 'get', {}, { version: 1 });
    await client.call(INFO, 'get');
    expect(fake.calls.map((c) => c.version)).toEqual([5, 2, 5]);
  });

  it('refuses an exact version the NAS lacks instead of silently using another', async () => {
    await setup({ catalog: { [INFO]: { minVersion: 1, maxVersion: 1 } } });
    await expect(client.call(INFO, 'get', {}, { version: 2, exactVersion: true })).rejects.toMatchObject({ kind: 'not_supported' });
    expect(fake.calls).toHaveLength(0);
  });

  it('explains a missing API by pointing at the package', async () => {
    await setup();
    const error = (await client.call('SYNO.Nope', 'get').catch((e) => e)) as DsmError;
    expect(error.kind).toBe('api_not_found');
    expect(error.hint).toContain('package');
  });

  it('recognizes a URL that is not DSM, such as Web Station on port 443', async () => {
    await setup();
    fake.catalogBody = '<html>Hello! Welcome to Synology Web Station!</html>';
    const error = (await client.catalog().catch((e) => e)) as DsmError;
    expect(error.kind).toBe('bad_reply');
    expect(error.hint).toContain('DSM port');
  });

  it('reports an unreachable NAS with a hint about the network path', async () => {
    fake = await new FakeDsm().start();
    client = clientFor(fake);
    await fake.stop();
    const error = (await client.catalog().catch((e) => e)) as DsmError;
    expect(error.kind).toBe('unreachable');
    expect(error.hint).toContain('VPN');
    fake = await new FakeDsm().start();
  });

  it('flags a failed write as possibly applied, and never resends it', async () => {
    await setup();
    let attempts = 0;
    fake.onRaw(INFO, 'set', (res) => {
      attempts += 1;
      res.destroy();
    });
    const error = (await client.call(INFO, 'set').catch((e) => e)) as DsmError;
    expect(attempts).toBe(1);
    expect(error.outcomeUnknown).toBe(true);
  });

  it('resends a read once when the connection drops', async () => {
    await setup();
    let attempts = 0;
    fake.onRaw(INFO, 'get', (res) => {
      attempts += 1;
      if (attempts === 1) {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { ok: true } }));
    });
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('ends the session on close', async () => {
    await setup();
    fake.on(INFO, 'get', () => ({}));
    await client.call(INFO, 'get');
    expect(fake.sessions.size).toBe(1);
    await client.logout();
    expect(fake.sessions.size).toBe(0);
  });

  it('treats a Container Manager stream by its final exit code', async () => {
    await setup();
    fake.onRaw(INFO, 'build_stream', (res) => {
      res.write('Step 1/2\n');
      res.write('Step 2/2\n');
      res.end('Exit Code: 3\n');
    });
    const result = await client.streamText(INFO, 'build_stream', {});
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('Step 2/2');
  });
});

describe('certificate pinning', () => {
  const tls = selfSignedCert();
  let fake: FakeDsm;
  let client: DsmClient;

  afterEach(async () => {
    await client?.close();
    await fake?.stop();
  });

  it('works with the pinned certificate, though it is self-signed and for another name', async () => {
    fake = await new FakeDsm({ tls }).start();
    fake.on(INFO, 'get', () => ({ ok: true }));
    client = clientFor(fake, {}, { certFingerprint: tls.fingerprint });
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
  });

  it('accepts the fingerprint in lower case without colons', async () => {
    fake = await new FakeDsm({ tls }).start();
    fake.on(INFO, 'get', () => ({ ok: true }));
    client = clientFor(fake, {}, { certFingerprint: tls.fingerprint.replaceAll(':', '').toLowerCase() });
    await expect(client.call(INFO, 'get')).resolves.toEqual({ ok: true });
  });

  it('refuses a different certificate before sending the password', async () => {
    fake = await new FakeDsm({ tls }).start();
    client = clientFor(fake, {}, { certFingerprint: 'AB:'.repeat(31) + 'AB' });
    const error = (await client.call(INFO, 'get').catch((e) => e)) as DsmError;
    expect(error.kind).toBe('tls_pin_mismatch');
    expect(error.hint).toContain('trust-cert');
    expect(fake.logins).toHaveLength(0);
  });

  it('rejects a self-signed certificate when nothing is pinned, and says how to pin it', async () => {
    fake = await new FakeDsm({ tls }).start();
    client = clientFor(fake);
    const error = (await client.catalog().catch((e) => e)) as DsmError;
    expect(error.message).toContain('not trusted');
    expect(error.hint).toContain('setup');
    expect(fake.logins).toHaveLength(0);
  });
});

describe('parameter encoding', () => {
  it('leaves strings raw by default and JSON-encodes lists and objects', () => {
    expect(encodeParams({ a: 'x', b: 1, c: true, d: ['y'], e: { f: 1 }, g: undefined, h: null })).toEqual({
      a: 'x',
      b: '1',
      c: 'true',
      d: '["y"]',
      e: '{"f":1}',
    });
  });

  it('quotes strings on request, as DSM reads 2024 unquoted as a number', () => {
    expect(encodeParams({ a: '2024' }, { quoteStrings: true })).toEqual({ a: '"2024"' });
    expect(q('2024')).toBe('"2024"');
  });

  it('recognizes read methods, so that only those are ever resent', () => {
    for (const method of ['get', 'list', 'load_info', 'getinfo', 'GetInfo', 'List', 'status', 'is_data_scrubbing', 'list_share', 'query', 'check']) {
      expect(isReadMethod(method), method).toBe(true);
    }
    for (const method of ['set', 'create', 'delete', 'start', 'stop', 'reboot', 'shutdown', 'upload', 'rename', 'save', 'kick_connection']) {
      expect(isReadMethod(method), method).toBe(false);
    }
  });
});

describe('credentials', () => {
  it('lets the environment override stored secrets', async () => {
    const store = new MemoryStore();
    await store.set('nas', 'password', 'stored');
    const provider = new CredentialProvider('nas', 'alice', store, { SYNOLOGY_PASSWORD: 'env', SYNOLOGY_DEVICE_ID: 'envdev' });
    await expect(provider.resolve()).resolves.toEqual({ username: 'alice', password: 'env', deviceId: 'envdev' });
    expect(provider.envOverridesDeviceId).toBe(true);
  });

  it('has nothing to offer without a username and password', async () => {
    const provider = new CredentialProvider('nas-with-no-secrets', undefined, new MemoryStore(), {});
    await expect(provider.resolve()).resolves.toBeUndefined();
  });

  it('picks up a new device token without a restart', async () => {
    const store = new MemoryStore();
    await store.set('nas', 'password', 'pw');
    const provider = new CredentialProvider('nas', 'alice', store, {});
    expect((await provider.resolve())?.deviceId).toBeUndefined();
    await provider.saveDeviceId('fresh');
    expect((await provider.resolve())?.deviceId).toBe('fresh');
  });
});

describe.runIf(process.platform === 'darwin' && process.env.TEST_KEYCHAIN === '1')('macOS Keychain', () => {
  it.each(['simple', 'pä"ss\\w ord$`x', "it's; rm -rf /", 'çãé€😀', ' spaces around ', 'line\nbreak', '123456', 'b64:looks-encoded'])(
    'returns %j exactly as stored',
    async (secret) => {
      const { KeychainStore } = await import('../src/credentials.js');
      const store = new KeychainStore();
      const instance = 'selftest-delete-me';
      try {
        await store.set(instance, 'password', secret);
        await expect(store.get(instance, 'password')).resolves.toBe(secret);
        await store.set(instance, 'password', 'replaced');
        await expect(store.get(instance, 'password')).resolves.toBe('replaced');
      } finally {
        await store.remove(instance, 'password');
      }
      await expect(store.get(instance, 'password')).resolves.toBeUndefined();
    },
  );
});
