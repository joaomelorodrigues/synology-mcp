/**
 * HTTP transport. DSM's default certificate is self-signed for "synology", so ordinary
 * verification fails against an IP address. Instead of switching verification off, the
 * certificate's SHA-256 fingerprint is pinned at setup and checked on every new connection,
 * after the handshake and before a single HTTP byte (and so the password) is sent.
 */
import { connect as tlsConnect } from 'node:tls';
import { Agent, buildConnector } from 'undici';
import { DsmError } from './errors.js';
export function normalizeFingerprint(value) {
    const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    return hex.match(/.{1,2}/g)?.join(':') ?? '';
}
export function pinMismatchError(expected, actual) {
    return new DsmError(`The NAS presented a different TLS certificate than the pinned one (pinned ${expected}, got ${actual ?? 'none'}).`, {
        kind: 'tls_pin_mismatch',
        hint: 'If you replaced or renewed the certificate on the NAS, run `synology-mcp trust-cert` to pin the new one. ' +
            'If you did not, do not proceed: something may be intercepting the connection.',
    });
}
function pinningConnector(fingerprint) {
    const expected = normalizeFingerprint(fingerprint);
    const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0, allowH2: false });
    return (options, callback) => {
        base(options, (error, socket) => {
            if (error) {
                callback(error, null);
                return;
            }
            const tlsSocket = socket;
            if (typeof tlsSocket.getPeerCertificate !== 'function') {
                // Plain HTTP has nothing to pin; config rejects that combination earlier.
                callback(null, socket);
                return;
            }
            const actual = tlsSocket.getPeerCertificate().fingerprint256;
            if (actual !== expected) {
                tlsSocket.destroy();
                callback(pinMismatchError(expected, actual), null);
                return;
            }
            callback(null, socket);
        });
    };
}
export function buildTransports(options) {
    const connect = options.certFingerprint
        ? pinningConnector(options.certFingerprint)
        : options.insecureTls
            ? { rejectUnauthorized: false }
            : undefined;
    // Time limits come from AbortSignal per call; long Docker builds must not hit undici's own.
    const shared = { headersTimeout: 0, bodyTimeout: 0, connect };
    return {
        pooled: new Agent({ ...shared, keepAliveTimeout: 20_000 }),
        single: new Agent({ ...shared, pipelining: 0 }),
    };
}
/** Read the certificate a host presents, for trust-on-first-use during setup. */
export function fetchPeerCertificate(url, timeoutMs = 8_000) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const socket = tlsConnect({
            host: target.hostname,
            port: Number(target.port || 443),
            servername: /^[\d.]+$/.test(target.hostname) ? undefined : target.hostname,
            rejectUnauthorized: false,
        });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ${target.host}`));
        }, timeoutMs);
        socket.once('secureConnect', () => {
            clearTimeout(timer);
            const cert = socket.getPeerCertificate();
            socket.end();
            if (!cert?.fingerprint256) {
                reject(new Error('The server did not present a certificate.'));
                return;
            }
            const commonName = (value) => (Array.isArray(value) ? value.join(', ') : (value ?? ''));
            resolve({
                fingerprint256: cert.fingerprint256,
                subject: commonName(cert.subject?.CN),
                issuer: commonName(cert.issuer?.CN),
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
            });
        });
        socket.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
