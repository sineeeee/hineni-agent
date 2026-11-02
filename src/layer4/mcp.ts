import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Config } from "../config/schema.js";
export async function mcpTools(
  config: Config,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const clients: Client[] = [],
    tools: AgentTool[] = [];
  try {
    for (const server of config.mcp.filter((s) => s.enabled)) {
      signal.throwIfAborted();
      const client = new Client({ name: "hineni", version: "0.1.0" });
      clients.push(client);
      const headers = server.headersEnv
        ? JSON.parse(env[server.headersEnv] ?? "{}")
        : {};
      const transport = server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers },
          })
        : new StdioClientTransport({
            command: server.command!,
            args: server.args,
            env: {
              ...Object.fromEntries(
                Object.entries(env).filter(
                  (x): x is [string, string] => x[1] !== undefined,
                ),
              ),
              ...server.env,
            },
          });
      await client.connect(transport, {
        timeout: config.runtime.mcpConnectTimeoutMs,
        signal,
      });
      let cursor: string | undefined;
      if (client.getServerCapabilities()?.tools)
        do {
          const page = await client.listTools(
            { cursor },
            { signal, timeout: config.runtime.toolTimeoutMs },
          );
          cursor = page.nextCursor;
          for (const tool of page.tools) {
            tools.push({
              name: `mcp_${server.name}_${tool.name}`.replace(/[^\w-]/g, "_"),
              label: tool.name,
              description: tool.description ?? tool.name,
              parameters: Type.Unsafe(tool.inputSchema),
              execute: async (_id, args, s) => {
                const result = await client.callTool(
                  { name: tool.name, arguments: args as any },
                  undefined,
                  { signal: s, timeout: config.runtime.toolTimeoutMs },
                );
                return {
                  content: ((result.content as any[]) ?? []).map((c) =>
                    c.type === "image"
                      ? { type: "image", data: c.data, mimeType: c.mimeType }
                      : { type: "text", text: c.text ?? JSON.stringify(c) },
                  ),
                  details: {},
                  isError: !!result.isError,
                };
              },
            });
          }
        } while (cursor);
      if (client.getServerCapabilities()?.resources) {
        tools.push({
          name: `mcp_${server.name}_list_resources`,
          label: "List resources",
          description: "列出这个 MCP 服务的资源和资源模板",
          parameters: Type.Object({ cursor: Type.Optional(Type.String()) }),
          execute: async (_id, args: any, s) => {
            const resources = await client.listResources(
              { cursor: args.cursor as string | undefined },
              { signal: s, timeout: config.runtime.toolTimeoutMs },
            );
            const templates = await client.listResourceTemplates(
              {},
              { signal: s, timeout: config.runtime.toolTimeoutMs },
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ resources, templates }),
                },
              ],
              details: {},
            };
          },
        });
        tools.push({
          name: `mcp_${server.name}_read_resource`,
          label: "Read resource",
          description: "读取这个 MCP 服务提供的资源 URI",
          parameters: Type.Object({ uri: Type.String() }),
          execute: async (_id, args: any, s) => {
            const result = await client.readResource(
              { uri: String(args.uri) },
              { signal: s, timeout: config.runtime.toolTimeoutMs },
            );
            return {
              content: result.contents.map((c) =>
                "text" in c
                  ? { type: "text" as const, text: c.text }
                  : { type: "text" as const, text: JSON.stringify(c) },
              ),
              details: {},
            };
          },
        });
      }
    }
  } catch (e) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw e;
  }
  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
