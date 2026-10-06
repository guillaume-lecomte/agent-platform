import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RiskLevel, Tool } from './types.js';

interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Maps MCP tool annotations to a risk level. Per the MCP spec, a tool that is not
 * read-only is assumed destructive unless it says otherwise, so the default is the
 * strictest level that still requires approval.
 */
export function riskFromMcpAnnotations(annotations: McpAnnotations | undefined): RiskLevel {
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === false) return 'reversible';
  return 'destructive';
}

export interface McpToolsOptions {
  /** Prefix added to tool names, to avoid collisions between servers. */
  prefix?: string;
  /** Override the risk derived from annotations. */
  risk?: (toolName: string, annotations: McpAnnotations | undefined) => RiskLevel;
}

/** Turns every tool exposed by a connected MCP server into a platform `Tool`. */
export async function mcpToolsFromClient(
  client: Client,
  options: McpToolsOptions = {},
): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      const annotations = t.annotations;
      const risk = options.risk?.(t.name, annotations) ?? riskFromMcpAnnotations(annotations);
      tools.push({
        name: `${options.prefix ?? ''}${t.name}`,
        description: t.description ?? t.name,
        inputSchema: t.inputSchema,
        risk,
        async execute(input, context) {
          const result = await client.callTool(
            { name: t.name, arguments: input },
            undefined,
            context.signal ? { signal: context.signal } : undefined,
          );
          const text = (Array.isArray(result.content) ? result.content : [])
            .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : undefined))
            .filter((s): s is string => typeof s === 'string')
            .join('\n');
          if (result.isError) throw new Error(text || `MCP tool ${t.name} failed`);
          return result.structuredContent ?? text;
        },
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Connects to an MCP server over an arbitrary transport and returns its tools. */
export async function connectMcpTools(
  transport: Transport,
  options: McpToolsOptions = {},
): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
  const client = new Client({ name: 'agent-platform', version: '0.1.0' });
  await client.connect(transport);
  return { tools: await mcpToolsFromClient(client, options), close: () => client.close() };
}

/** Spawns an MCP server as a child process (stdio transport) and returns its tools. */
export function connectMcpStdio(
  command: string,
  args: string[] = [],
  options: McpToolsOptions = {},
): ReturnType<typeof connectMcpTools> {
  return connectMcpTools(new StdioClientTransport({ command, args }), options);
}
