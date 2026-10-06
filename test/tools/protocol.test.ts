import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { makeTestServer, type TestServer } from '../helpers/make-server.js';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe('tools/list over the real protocol', () => {
  it('advertises every tool', async () => {
    srv = await makeTestServer({});
    const { tools } = await srv.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('generates non-empty JSON Schema for every tool', async () => {
    // The Zod-version guard. The SDK's peer range allows Zod 4, but it depends
    // on zod-to-json-schema@3, which only understands Zod 3 internals; with
    // Zod 4 the schemas convert to empty objects and tools silently become
    // uncallable. This test is what makes that failure visible.
    srv = await makeTestServer({});
    const { tools } = await srv.client.listTools();
    for (const t of tools) {
      const schema = t.inputSchema as { type?: string; properties?: Record<string, unknown> };
      expect(schema.type, `${t.name} schema type`).toBe('object');
      expect(
        Object.keys(schema.properties ?? {}).length,
        `${t.name} must expose properties`,
      ).toBeGreaterThan(0);
    }
  });

  it('declares the expected arguments on the key tools', async () => {
    srv = await makeTestServer({});
    const { tools } = await srv.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const arrivals = byName.get('stop_arrivals')!;
    const aProps = Object.keys(
      (arrivals.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(aProps).toContain('stop');
    expect((arrivals.inputSchema as { required?: string[] }).required).toContain('stop');

    const find = byName.get('find_stops')!;
    const fProps = Object.keys(
      (find.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(fProps).toEqual(expect.arrayContaining(['query', 'lat', 'lon', 'radius_m', 'limit']));
  });

  it('gives every tool a substantial description that names the scope', async () => {
    srv = await makeTestServer({});
    const { tools } = await srv.client.listTools();
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.description!.length, t.name).toBeGreaterThan(80);
      expect(t.description!.length, t.name).toBeLessThan(2000);
      // A model needs to know this only covers Athens.
      expect(t.description, t.name).toMatch(/Attica/);
    }
  });

  it('marks every tool read-only', async () => {
    srv = await makeTestServer({});
    const { tools } = await srv.client.listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it('has no duplicate tool names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
