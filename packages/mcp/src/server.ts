import { TOOL_DEFINITIONS, ToolInputError, callTool } from "./tools.js";

type RequestId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const SERVER_INFO = { name: "moemodels", version: "0.1.0" } as const;
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION, "2024-11-05"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function response(id: RequestId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Tool execution failed.";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function toolSuccess(result: JsonObject) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

export async function handleJsonRpcMessage(message: unknown): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(null, -32600, "Invalid JSON-RPC request.");
  }
  const id =
    typeof message.id === "string" || typeof message.id === "number" || message.id === null
      ? message.id
      : undefined;
  const notification = id === undefined;

  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    return null;
  }

  if (message.method === "initialize") {
    if (notification) return null;
    const params = isObject(message.params) ? message.params : {};
    const requested =
      typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    return response(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Use sourced model facts, calculated static fit, and evaluation evidence according to their labels. No tool claims measured performance unless a normalized measured run exists.",
    });
  }

  if (notification) return null;

  if (message.method === "ping") return response(id, {});

  if (message.method === "tools/list") {
    return response(id, { tools: TOOL_DEFINITIONS });
  }

  if (message.method === "tools/call") {
    const params = isObject(message.params) ? message.params : {};
    if (typeof params.name !== "string" || params.name.trim() === "") {
      return errorResponse(id, -32602, "tools/call requires a non-empty tool name.");
    }
    try {
      return response(id, toolSuccess(callTool(params.name, params.arguments)));
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof RangeError) {
        return response(id, toolError(error));
      }
      return response(id, toolError(error));
    }
  }

  return errorResponse(id, -32601, `Method not found: ${message.method}`);
}

function writeMessage(message: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function startStdioServer(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          writeMessage(errorResponse(null, -32700, "Parse error."));
          newline = buffer.indexOf("\n");
          continue;
        }
        const reply = await handleJsonRpcMessage(parsed);
        if (reply !== null) writeMessage(reply);
      }
      newline = buffer.indexOf("\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing !== "") {
    try {
      const reply = await handleJsonRpcMessage(JSON.parse(trailing) as unknown);
      if (reply !== null) writeMessage(reply);
    } catch {
      writeMessage(errorResponse(null, -32700, "Parse error."));
    }
  }
}

export { TOOL_DEFINITIONS, callTool } from "./tools.js";
