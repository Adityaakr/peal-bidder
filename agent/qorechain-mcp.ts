/**
 * The QoreChain MCP server (`@qorechain/mcp`), run in this process and spoken
 * to over the Model Context Protocol, as the agent's read-only view of the
 * chain for its audit.
 *
 * Why MCP rather than plain REST: it is QoreChain's tool interface for AI
 * agents, it never signs or holds keys, and its answers are already the checks
 * the audit needs. `get_transaction` decodes a linked-key refusal inside a
 * code-0 transaction (`success: false` with the chain's reason), and
 * `get_pq_status` verifies a transaction's ML-DSA-87 layer locally against the
 * key its signer registered, rather than reading a label. The same server is
 * what the owner's assistant gets from the repository's `.mcp.json`, and what
 * `pnpm qore` runs, so the agent, the owner and the owner's assistant ask the
 * chain the same questions and get the same answers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "@qorechain/mcp";

/** A failed tool call, with the server's stable code (`NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, ...). */
export class ChainToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
  ) {
    super(`${tool}: ${code}: ${message}`);
  }
}

/** What the audit needs from the chain: one call of one QoreChain MCP tool. */
export interface ChainTools {
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

function payload(tool: string, r: ToolResult): Record<string, unknown> {
  let body: unknown = r.structuredContent;
  if (body === undefined) {
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    try {
      body = JSON.parse(text);
    } catch {
      throw new ChainToolError(tool, r.isError ? "TOOL_ERROR" : "BAD_REPLY", text.slice(0, 200));
    }
  }
  if (typeof body !== "object" || body === null) throw new ChainToolError(tool, "BAD_REPLY", "not an object");
  const err = (body as { error?: { code?: string; message?: string } }).error;
  if (r.isError || err) throw new ChainToolError(tool, err?.code ?? "TOOL_ERROR", err?.message ?? "the tool failed");
  return body as Record<string, unknown>;
}

/** Start the QoreChain MCP server in this process and connect an MCP client to it. */
export async function connectQoreChainMcp(options: ServerOptions = {}): Promise<ChainTools> {
  const server = createServer({ defaultNetwork: "testnet", ...options });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "peal-bidder-audit", version: "1" });
  await client.connect(clientSide);
  return {
    async call(tool, args) {
      return payload(tool, (await client.callTool({ name: tool, arguments: args })) as ToolResult);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
