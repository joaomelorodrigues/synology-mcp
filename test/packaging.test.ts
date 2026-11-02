/** What makes `npm install -g github:owner/repo` work. See the note in the README. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('installing from GitHub', () => {
  it.each(['build', 'prepare', 'prepack', 'preinstall', 'install', 'postinstall'])('has no %s script, which breaks a global install from git', (name) => {
    // Any of these makes npm "prepare" a git dependency by running `npm install` in a temporary
    // clone. With -g that setting leaks into the child, which installs the clone globally: the
    // package ends up as a symlink to a folder npm then deletes, and the install still says it worked.
    expect(pkg.scripts[name]).toBeUndefined();
  });

  it('runs the compiled code without any development dependency', () => {
    expect(pkg.bin['synology-mcp']).toBe('dist/index.js');
    expect(readFileSync('dist/index.js', 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    const source = execFileSync('grep', ['-rhoE', "from '[^.'][^']*'", 'dist'], { encoding: 'utf8' });
    const imported = new Set(source.split('\n').filter(Boolean).map((line) => line.slice(6, -1)));
    for (const name of imported) {
      if (name.startsWith('node:')) continue;
      const root = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;
      expect(Object.keys(pkg.dependencies), name).toContain(root);
    }
  });

  it('keeps dist out of .gitignore, and ships it', () => {
    expect(readFileSync('.gitignore', 'utf8')).not.toMatch(/^dist\/?$/m);
    const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
    const files = report.files.map((f: { path: string }) => f.path);
    expect(files).toContain('dist/index.js');
    expect(files).toContain('package.json');
    expect(files.some((f: string) => f.startsWith('src/') || f.startsWith('test/'))).toBe(false);
  });
});
