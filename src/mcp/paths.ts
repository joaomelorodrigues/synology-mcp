/**
 * Guards for NAS and local paths. These run before anything is sent to the NAS, because DSM's
 * own behavior here is unforgiving: File Station's delete of `/share` removes the shared folder
 * itself, beyond the reach of its recycle bin.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DsmError } from '../dsm/errors.js';

function refused(message: string, hint?: string): DsmError {
  return new DsmError(message, { kind: 'refused', hint });
}

function invalid(message: string): DsmError {
  return new DsmError(message, { kind: 'invalid_parameter' });
}

/** Normalize a NAS path: leading slash, no trailing slash, no `.` or `..` or empty parts. */
export function normalizeNasPath(input: string): string {
  const path = input.trim();
  if (!path) throw invalid('The path is empty.');
  if (path.includes('\0')) throw invalid('The path contains a NUL character.');
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  for (const part of parts) {
    if (part === '.' || part === '..') throw invalid(`Path "${input}" contains a relative part ("${part}"). Use a full path.`);
    if (part.trim() === '') throw invalid(`Path "${input}" contains an empty part.`);
  }
  return `/${parts.join('/')}`;
}

export function isShareRoot(path: string): boolean {
  return path.split('/').length === 2;
}

/** `/share/#recycle`, or a user's bin as an administrator sees it: `/homes/user/#recycle`. */
export function isRecycleRoot(path: string): boolean {
  const parts = path.split('/').slice(1);
  if (parts.length === 2) return parts[1] === '#recycle';
  return parts.length === 3 && parts[0] === 'homes' && parts[2] === '#recycle';
}

function isAtOrBelow(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

const DRIVE_ROOTS = new Set(['mydrive', 'team-folders', 'shared-with-me', 'recycle-bin']);

/**
 * Drive addresses files under its own roots, while File Station shows the same files as
 * /Team/... and /home/Drive/.... DSM answers those spellings with a bare error 1000, so they are
 * translated here.
 */
export function normalizeDrivePath(input: string): string {
  const path = normalizeNasPath(input);
  const [root, ...rest] = path.slice(1).split('/');
  if (DRIVE_ROOTS.has(root!)) return path;
  if (root === 'home' && rest[0] === 'Drive') return ['/mydrive', ...rest.slice(1)].join('/');
  if (root === 'home' || root === 'homes') {
    throw invalid(`"${input}" is not in Drive. Of a home folder, Drive sees only /home/Drive, which it calls /mydrive. Use the files_ tools for the rest.`);
  }
  return `/team-folders/${path.slice(1)}`;
}

/** A lowercased path as File Station spells it, so a guard holds whichever way it was written. */
function fileStationForm(path: string): string {
  if (isAtOrBelow(path, '/mydrive')) return `/home/drive${path.slice('/mydrive'.length)}`;
  if (path.startsWith('/team-folders/')) return path.slice('/team-folders'.length);
  return path;
}

export function assertNotProtected(path: string, protectedPaths: readonly string[]): void {
  const target = path.toLowerCase();
  for (const entry of protectedPaths) {
    const guarded = normalizeNasPath(entry);
    const parent = guarded.toLowerCase();
    if (isAtOrBelow(target, parent) || isAtOrBelow(fileStationForm(target), fileStationForm(parent))) {
      throw refused(`"${path}" is protected by this server's protectedPaths setting (${guarded}).`, 'Ask the owner to change it in the config if this is intended.');
    }
  }
}

/** For delete, move and rename: never a whole shared folder or a whole recycle bin. */
export function assertRemovable(path: string, protectedPaths: readonly string[]): void {
  if (isShareRoot(path)) {
    throw refused(
      `"${path}" is a whole shared folder. Deleting, moving or renaming it through File Station removes the shared folder itself, beyond its recycle bin.`,
      'Work with the items inside it. To remove the shared folder on purpose, use share_delete.',
    );
  }
  if (isRecycleRoot(path) || isRecycleRoot(fileStationForm(path.toLowerCase()))) {
    throw refused(`"${path}" is a whole recycle bin. Changing it would affect every user's deleted items for good.`, 'Work with the items inside it by path.');
  }
  assertNotProtected(path, protectedPaths);
}

/**
 * Resolve symlinks and `..`, then require the result to sit inside an allowed local folder. That
 * check comes before any answer about existence, so a caller can't use the difference between
 * "refused" and "not found" to learn what exists outside those folders.
 */
export function resolveLocalPath(input: string, roots: readonly string[], options: { mustExist: boolean }): string {
  if (!isAbsolute(input)) throw invalid(`Local path must be absolute; got "${input}".`);
  const absolute = resolve(input);

  // Resolve the part that exists, so a symlink along the way can't lead out unnoticed.
  let existing = absolute;
  const missing: string[] = [];
  let real: string;
  while (true) {
    try {
      real = realpathSync(existing);
      break;
    } catch {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const target = join(real, ...missing);

  const allowed = roots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  if (!allowed.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) {
    throw refused(`Local path "${absolute}" is outside the allowed folders (${roots.join(', ') || 'none'}).`, 'Add the folder to localRoots in the config.');
  }

  if (options.mustExist && missing.length > 0) {
    throw new DsmError(`Local path does not exist: ${absolute}`, { kind: 'not_found' });
  }
  if (missing.length > 1) {
    throw new DsmError(`Local folder does not exist: ${dirname(absolute)}`, { kind: 'not_found' });
  }
  return target;
}

export function localFileSize(path: string): number {
  return statSync(path).size;
}

/** Split `/share/dir/file.txt` into its folder and name. */
export function splitNasPath(path: string): { folder: string; name: string } {
  const index = path.lastIndexOf('/');
  return { folder: path.slice(0, index) || '/', name: path.slice(index + 1) };
}
