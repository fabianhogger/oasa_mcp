import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { VERSION } from '../../src/version.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('packaging', () => {
  it('keeps the version constant in step with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('ships the built output and nothing stray', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
      bin: Record<string, string>;
    };
    expect(pkg.files).toContain('dist');
    expect(pkg.bin['oasa-mcp']).toBe('dist/index.js');
    // Fixtures and tests must never reach the published tarball.
    expect(pkg.files.some((f) => f.includes('test'))).toBe(false);
  });
});

describe('tool definitions', () => {
  it('names tools in snake_case', () => {
    for (const t of TOOLS) expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('gives each tool a title and a declared input schema', () => {
    for (const t of TOOLS) {
      expect(t.title, t.name).toBeTruthy();
      expect(Object.keys(t.inputSchema).length, t.name).toBeGreaterThan(0);
    }
  });
});

describe('stdout purity', () => {
  it('writes only JSON-RPC to stdout and all logs to stderr', async () => {
    // A single stray console.log would corrupt the protocol stream and the
    // client would disconnect, so this is checked against the real binary.
    const entry = join(ROOT, 'dist', 'index.js');
    if (!existsSync(entry)) {
      // Built output is required for this check; `npm test` runs after build in CI.
      return;
    }

    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, OASA_LOG_LEVEL: 'debug', OASA_NO_DISK_CACHE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'purity-test', version: '1.0.0' },
      },
    };
    child.stdin.write(`${JSON.stringify(initialize)}\n`);

    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGTERM');

    const lines = stdout.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    // The ready banner proves logging happened, and that it went to stderr.
    expect(stderr).toMatch(/oasa-mcp/);
  }, 15_000);
});
