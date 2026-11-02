/**
 * Guards for NAS and local paths. These run before anything is sent to the NAS, because DSM's
 * own behavior here is unforgiving: File Station's delete of `/share` removes the shared folder
 * itself, beyond the reach of its recycle bin.
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DsmError } from '../dsm/errors.js';
function refused(message, hint) {
    return new DsmError(message, { kind: 'refused', hint });
}
function invalid(message) {
    return new DsmError(message, { kind: 'invalid_parameter' });
}
/** Normalize a NAS path: leading slash, no trailing slash, no `.` or `..` or empty parts. */
export function normalizeNasPath(input) {
    const path = input.trim();
    if (!path)
        throw invalid('The path is empty.');
    if (path.includes('\0'))
        throw invalid('The path contains a NUL character.');
    const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    for (const part of parts) {
        if (part === '.' || part === '..')
            throw invalid(`Path "${input}" contains a relative part ("${part}"). Use a full path.`);
        if (part.trim() === '')
            throw invalid(`Path "${input}" contains an empty part.`);
    }
    return `/${parts.join('/')}`;
}
export function isShareRoot(path) {
    return path.split('/').length === 2;
}
/** `/share/#recycle`, or a user's bin as an administrator sees it: `/homes/user/#recycle`. */
export function isRecycleRoot(path) {
    const parts = path.split('/').slice(1);
    if (parts.length === 2)
        return parts[1] === '#recycle';
    return parts.length === 3 && parts[0] === 'homes' && parts[2] === '#recycle';
}
function isAtOrBelow(path, parent) {
    return path === parent || path.startsWith(`${parent}/`);
}
export function assertNotProtected(path, protectedPaths) {
    for (const entry of protectedPaths) {
        const guarded = normalizeNasPath(entry);
        if (isAtOrBelow(path.toLowerCase(), guarded.toLowerCase())) {
            throw refused(`"${path}" is protected by this server's protectedPaths setting (${guarded}).`, 'Ask the owner to change it in the config if this is intended.');
        }
    }
}
/** For delete, move and rename: never a whole shared folder or a whole recycle bin. */
export function assertRemovable(path, protectedPaths) {
    if (isShareRoot(path)) {
        throw refused(`"${path}" is a whole shared folder. Deleting, moving or renaming it through File Station removes the shared folder itself, beyond its recycle bin.`, 'Work with the items inside it. To remove the shared folder on purpose, use share_delete.');
    }
    if (isRecycleRoot(path)) {
        throw refused(`"${path}" is a whole recycle bin. Changing it would affect every user's deleted items for good.`, 'Work with the items inside it by path.');
    }
    assertNotProtected(path, protectedPaths);
}
/** Resolve symlinks and `..`, then require the result to sit inside an allowed local folder. */
export function resolveLocalPath(input, roots, options) {
    if (!isAbsolute(input))
        throw invalid(`Local path must be absolute; got "${input}".`);
    const absolute = resolve(input);
    let real;
    if (options.mustExist) {
        try {
            real = realpathSync(absolute);
        }
        catch {
            throw new DsmError(`Local path does not exist: ${absolute}`, { kind: 'not_found' });
        }
    }
    else {
        let parent = dirname(absolute);
        try {
            parent = realpathSync(parent);
        }
        catch {
            throw new DsmError(`Local folder does not exist: ${parent}`, { kind: 'not_found' });
        }
        real = join(parent, basename(absolute));
    }
    const allowed = roots.flatMap((root) => {
        try {
            return [realpathSync(root)];
        }
        catch {
            return [];
        }
    });
    if (!allowed.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) {
        throw refused(`Local path "${real}" is outside the allowed folders (${roots.join(', ') || 'none'}).`, 'Add the folder to localRoots in the config.');
    }
    return real;
}
export function localFileSize(path) {
    return statSync(path).size;
}
/** Split `/share/dir/file.txt` into its folder and name. */
export function splitNasPath(path) {
    const index = path.lastIndexOf('/');
    return { folder: path.slice(0, index) || '/', name: path.slice(index + 1) };
}
