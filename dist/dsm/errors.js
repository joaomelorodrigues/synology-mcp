/**
 * DSM error model. Every failure a tool can report is a DsmError carrying a stable `kind`,
 * DSM's numeric code when there is one, and a `hint` telling the caller what to do next.
 */
export class DsmError extends Error {
    kind;
    code;
    api;
    method;
    hint;
    retryable;
    details;
    outcomeUnknown;
    constructor(message, init) {
        super(message);
        this.name = 'DsmError';
        this.kind = init.kind;
        this.code = init.code;
        this.api = init.api;
        this.method = init.method;
        this.hint = init.hint;
        this.retryable = init.retryable ?? false;
        this.details = init.details;
        this.outcomeUnknown = init.outcomeUnknown ?? false;
    }
    toJSON() {
        const call = this.api ? `${this.api}/${this.method ?? '?'}` : undefined;
        return {
            kind: this.kind,
            message: this.message,
            ...(this.code !== undefined ? { code: this.code } : {}),
            ...(call ? { call } : {}),
            ...(this.hint ? { hint: this.hint } : {}),
            ...(this.retryable ? { retryable: true } : {}),
            ...(this.outcomeUnknown ? { outcome_unknown: true } : {}),
            ...(this.details !== undefined ? { details: this.details } : {}),
        };
    }
}
/** Codes shared by every DSM API. */
const COMMON = {
    100: { kind: 'dsm_error', message: 'Unknown DSM error' },
    101: {
        kind: 'invalid_parameter',
        message: 'Missing or invalid parameter (or the API refused this call shape)',
        hint: 'Check required parameters. Some APIs need a different version; use dsm_api_search to see the versions available.',
    },
    102: {
        kind: 'api_not_found',
        message: 'The requested API does not exist on this NAS',
        hint: 'The package that provides it is probably not installed or not running. Check packages_list.',
    },
    103: { kind: 'not_supported', message: 'The API does not have this method on this DSM version' },
    104: {
        kind: 'not_supported',
        message: 'The requested API version is not supported',
        hint: 'Use dsm_api_search to see the versions this NAS offers.',
    },
    105: {
        kind: 'permission_denied',
        message: 'This DSM account has no permission for this call',
        hint: 'Most system, storage and account APIs need an administrator account. This is not a session problem.',
    },
    106: { kind: 'session_expired', message: 'Session timed out', retryable: true },
    107: { kind: 'session_expired', message: 'Session interrupted by a duplicate login', retryable: true },
    108: { kind: 'dsm_error', message: 'Failed to upload the file' },
    109: { kind: 'unreachable', message: 'The network connection is unstable or the system is busy', retryable: true },
    110: { kind: 'busy', message: 'The system is currently busy', retryable: true },
    111: { kind: 'busy', message: 'The system is currently busy', retryable: true },
    112: { kind: 'not_supported', message: 'This operation is not supported on this DSM' },
    113: { kind: 'not_supported', message: 'The Application Portal is not available for this operation' },
    114: { kind: 'invalid_parameter', message: 'Missing required parameters' },
    115: { kind: 'permission_denied', message: 'Not permitted to access this resource' },
    116: { kind: 'not_supported', message: 'Not allowed in demo mode' },
    117: {
        kind: 'invalid_parameter',
        message: 'DSM refused the request (often: the named object does not exist)',
    },
    118: { kind: 'not_supported', message: 'The operation is restricted on this DSM' },
    119: { kind: 'session_expired', message: 'Session ID not found or invalid', retryable: true },
    120: { kind: 'invalid_parameter', message: 'A parameter has the wrong type' },
    121: { kind: 'not_supported', message: 'Not supported on this NAS' },
    150: {
        kind: 'permission_denied',
        message: 'The source IP does not match the IP the session logged in from',
        hint: 'The VPN address or route changed mid-session. Retry; a new login will be made.',
        retryable: true,
    },
    160: {
        kind: 'permission_denied',
        message: 'This account lacks the application privilege for this package',
        hint: 'Grant it in Control Panel > Application Privileges.',
    },
};
/** SYNO.API.Auth codes. */
const AUTH = {
    400: { kind: 'auth_failed', message: 'No such account or incorrect password' },
    401: { kind: 'auth_failed', message: 'The DSM account is disabled' },
    402: { kind: 'auth_failed', message: 'Permission denied, or the account is not allowed to log in here' },
    403: { kind: 'auth_failed', message: 'A 2FA code is required for this account' },
    404: { kind: 'auth_failed', message: 'The 2FA code or trusted-device token was not accepted' },
    405: { kind: 'auth_failed', message: 'App portal login is not allowed for this account' },
    406: { kind: 'auth_failed', message: '2FA is enforced for this account and no valid code was sent' },
    407: {
        kind: 'login_blocked',
        message: "This computer's IP address is blocked by DSM Auto Block",
        hint: 'Remove it in Control Panel > Security > Protection > Allow/Block List, then restart this server.',
    },
    408: { kind: 'auth_failed', message: 'The password has expired and cannot be changed' },
    409: { kind: 'auth_failed', message: 'The password has expired' },
    410: { kind: 'auth_failed', message: 'The password must be changed before logging in' },
};
/** SYNO.FileStation.* codes. */
const FILESTATION = {
    400: { kind: 'invalid_parameter', message: 'Invalid parameter of file operation' },
    401: { kind: 'dsm_error', message: 'Unknown error of file operation' },
    402: { kind: 'busy', message: 'The system is too busy', retryable: true },
    403: { kind: 'invalid_parameter', message: 'Invalid user for this file operation' },
    404: { kind: 'invalid_parameter', message: 'Invalid group for this file operation' },
    405: { kind: 'invalid_parameter', message: 'Invalid user and group for this file operation' },
    406: { kind: 'dsm_error', message: 'Could not get user or group information' },
    407: {
        kind: 'permission_denied',
        message: 'This account has no permission on this path',
        hint: 'Check the shared folder permissions for this DSM account.',
    },
    408: { kind: 'not_found', message: 'No such file or directory', hint: 'Check the path with files_list.' },
    409: { kind: 'not_supported', message: 'This file system does not support the operation' },
    410: { kind: 'unreachable', message: 'Failed to connect to an internet-based file system', retryable: true },
    411: { kind: 'filesystem_error', message: 'Read-only file system' },
    412: { kind: 'invalid_parameter', message: 'File name too long' },
    413: { kind: 'invalid_parameter', message: 'File name too long for an encrypted share' },
    414: { kind: 'already_exists', message: 'File already exists', hint: 'Pass overwrite=true to replace it.' },
    415: { kind: 'disk_full', message: 'Disk quota exceeded' },
    416: { kind: 'disk_full', message: 'No space left on the device' },
    417: { kind: 'filesystem_error', message: 'Input/output error', retryable: true },
    418: { kind: 'invalid_parameter', message: 'Illegal name or path' },
    419: { kind: 'invalid_parameter', message: 'Illegal file name' },
    420: { kind: 'invalid_parameter', message: 'Illegal file name on a FAT file system' },
    421: { kind: 'busy', message: 'The system is too busy', retryable: true },
    599: { kind: 'not_found', message: 'No such background task (it finished or was cleaned up)' },
    900: { kind: 'filesystem_error', message: 'The folder is not empty', hint: 'Pass recursive=true to delete its contents too.' },
    1000: { kind: 'dsm_error', message: 'Failed to copy files or folders' },
    1001: { kind: 'dsm_error', message: 'Failed to move files or folders' },
    1002: { kind: 'dsm_error', message: 'An error occurred at the destination' },
    1003: { kind: 'invalid_parameter', message: 'Cannot overwrite or skip the existing file: no overwrite option given' },
    1004: { kind: 'already_exists', message: 'A folder with the same name already exists at the destination' },
    1006: { kind: 'invalid_parameter', message: 'Cannot copy or move a file onto a folder of the same name' },
    1100: { kind: 'dsm_error', message: 'Failed to create the folder' },
    1101: { kind: 'invalid_parameter', message: 'The number of folders in the parent exceeds the system limit' },
    1200: { kind: 'dsm_error', message: 'Failed to rename' },
    1800: { kind: 'dsm_error', message: 'Upload data is incomplete or not received in time' },
    1801: { kind: 'unreachable', message: 'Upload timed out waiting for data', retryable: true },
    1802: { kind: 'invalid_parameter', message: 'Upload carried no file name' },
    1803: { kind: 'dsm_error', message: 'Upload connection was cancelled' },
    1804: { kind: 'disk_full', message: 'File too big for the FAT file system' },
    1805: { kind: 'already_exists', message: 'Cannot overwrite or skip the existing file' },
    2000: { kind: 'dsm_error', message: 'Sharing link operation failed' },
    2001: { kind: 'dsm_error', message: 'Too many sharing links' },
    2002: { kind: 'permission_denied', message: 'Cannot access the sharing link' },
    3000: { kind: 'dsm_error', message: 'Sharing link failed' },
    3001: { kind: 'dsm_error', message: 'Too many sharing links' },
    3002: { kind: 'permission_denied', message: 'Cannot access the sharing link' },
    3006: { kind: 'not_found', message: 'Sharing link does not exist' },
};
/** SYNO.Core.* and SYNO.Storage.* codes the references document. */
const CORE = {
    402: { kind: 'not_found', message: 'The named object does not exist' },
    403: { kind: 'invalid_parameter', message: 'Missing or malformed parameter for this API' },
    404: { kind: 'not_found', message: 'The named object does not exist or is not visible to this account' },
};
/** Download Station task codes. */
const DOWNLOADSTATION = {
    400: { kind: 'dsm_error', message: 'File upload failed' },
    401: { kind: 'dsm_error', message: 'Maximum number of tasks reached' },
    402: { kind: 'invalid_parameter', message: 'Destination denied' },
    403: { kind: 'not_found', message: 'Destination does not exist', hint: 'Create it first with files_mkdir, then pass it without a leading slash.' },
    404: { kind: 'not_found', message: 'Invalid task id' },
    405: { kind: 'invalid_parameter', message: 'Invalid task action' },
    406: { kind: 'invalid_parameter', message: 'No default destination set', hint: 'Pass destination, or set a default in Download Station.' },
};
/** Photos codes. */
const FOTO = {
    602: { kind: 'permission_denied', message: 'Shared Space is not available to this account' },
    801: { kind: 'permission_denied', message: 'Personal space is unavailable: enable the user home service in Control Panel > User & Group > Advanced' },
    803: { kind: 'permission_denied', message: 'No permission for this Shared Space folder' },
};
/** Synology Office and Drive codes, as their own web clients handle them. */
const OFFICE = {
    1002: { kind: 'permission_denied', message: 'This account has no permission on this file or folder' },
    1003: {
        kind: 'not_found',
        message: 'The file or folder does not exist in Drive, or Drive has not indexed it yet',
        hint: 'A folder created moments ago outside Drive takes a while to appear. Check with drive_list, then retry.',
        retryable: true,
    },
    1036: {
        kind: 'not_found',
        message: 'The file or folder does not exist in Drive, or Drive has not indexed it yet',
        hint: 'A folder created moments ago outside Drive takes a while to appear. Check with drive_list, then retry.',
        retryable: true,
    },
    1038: { kind: 'not_found', message: 'This link has expired' },
    57373: { kind: 'permission_denied', message: 'This document is encrypted and needs its password', hint: 'Pass password.' },
    57383: { kind: 'permission_denied', message: 'This account cannot read this document' },
    57402: { kind: 'already_exists', message: 'A version with this name already exists', hint: 'Pass overwrite=true to reuse the name.' },
    57403: { kind: 'not_supported', message: 'The document format and this Synology Office version do not match', hint: 'Check for a Synology Office update in Package Center.' },
};
function lookup(api, code) {
    let family;
    if (api === 'SYNO.API.Auth')
        family = AUTH;
    else if (api.startsWith('SYNO.FileStation'))
        family = FILESTATION;
    else if (api.startsWith('SYNO.DownloadStation'))
        family = DOWNLOADSTATION;
    else if (api.startsWith('SYNO.Foto'))
        family = FOTO;
    else if (api.startsWith('SYNO.Office') || api.startsWith('SYNO.SynologyDrive'))
        family = OFFICE;
    else if (api.startsWith('SYNO.Core') || api.startsWith('SYNO.Storage'))
        family = CORE;
    return family?.[code] ?? COMMON[code];
}
/** Session codes that a fresh login can fix. 105 is never one of them. */
export const SESSION_CODES = new Set([106, 107, 119]);
export function errorFromCode(api, method, code, details) {
    const info = lookup(api, code);
    return new DsmError(info?.message ?? `DSM error ${code}`, {
        kind: info?.kind ?? 'dsm_error',
        code,
        api,
        method,
        hint: info?.hint,
        retryable: info?.retryable,
        details: details === undefined || (Array.isArray(details) && details.length === 0) ? undefined : details,
    });
}
