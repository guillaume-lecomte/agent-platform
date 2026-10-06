import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mcpToolsFromClient, riskFromMcpAnnotations } from '../src/index.js';

async function startServer(): Promise<Client> {
  const server = new McpServer({ name: 'minimal', version: '0.0.1' });
  server.registerTool(
    'lookup',
    {
      description: 'Look up a word',
      inputSchema: { word: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ word }) => ({ content: [{ type: 'text', text: `definition of ${word}` }] }),
  );
  server.registerTool(
    'archive',
    {
      description: 'Archive a record',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id }) => ({ content: [{ type: 'text', text: `archived ${id}` }] }),
  );
  server.registerTool('wipe', { description: 'Wipe everything', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP client adapter', () => {
  it('exposes server tools as platform Tools with risk derived from annotations', async () => {
    const client = await startServer();
    const tools = await mcpToolsFromClient(client, { prefix: 'ext_' });
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ['ext_lookup', 'read'],
      ['ext_archive', 'reversible'],
      ['ext_wipe', 'destructive'],
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['word'] });
  });

  it('executes through the server and surfaces tool errors as exceptions', async () => {
    const client = await startServer();
    const tools = await mcpToolsFromClient(client);
    const lookup = tools.find((t) => t.name === 'lookup');
    const wipe = tools.find((t) => t.name === 'wipe');
    expect(await lookup?.execute({ word: 'idempotent' }, { idempotencyKey: 'k' })).toBe(
      'definition of idempotent',
    );
    await expect(wipe?.execute({}, { idempotencyKey: 'k2' })).rejects.toThrow('nope');
  });

  it('assumes destructive when annotations are absent', () => {
    expect(riskFromMcpAnnotations(undefined)).toBe('destructive');
    expect(riskFromMcpAnnotations({ readOnlyHint: false })).toBe('destructive');
  });
});
