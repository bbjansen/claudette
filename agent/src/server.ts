import * as http from "node:http";
import type { AccountPool } from "./pool.js";
import { handleAccountsSnapshot, handleAccountsDisable, handleAccountsEnable } from "./admin.js";
import type { OllamaForwarder } from "./ollama.js";

export interface ServerDeps {
  pool: AccountPool;
  upstream: (body: Buffer, accept: string, pool: AccountPool, accountHint?: string | null, betaHeader?: string | null) => Promise<Response>;
  // Optional local-Ollama relay. When set, POST /v1/ollama/chat/completions and
  // /v1/ollama/embeddings are forwarded to the operator's local Ollama server.
  ollama?: OllamaForwarder;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length",
]);

const ADMIN_DISABLE = /^\/v1\/admin\/accounts\/([^/]+)\/disable$/;
const ADMIN_ENABLE  = /^\/v1\/admin\/accounts\/([^/]+)\/enable$/;
const OLLAMA_PREFIX = "/v1/ollama/";
const OLLAMA_ROUTES = new Set(["/v1/ollama/chat/completions", "/v1/ollama/embeddings"]);

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/messages") {
        return handleMessages(req, res, deps);
      }
      if (req.method === "POST" && OLLAMA_ROUTES.has(url)) {
        return handleOllama(req, res, deps, url);
      }
      if (req.method === "GET" && url === "/v1/admin/accounts") {
        return pipeResponse(res, handleAccountsSnapshot({ pool: deps.pool }));
      }
      if (req.method === "POST") {
        const disableMatch = url.match(ADMIN_DISABLE);
        if (disableMatch) {
          const acctId = decodeURIComponent(disableMatch[1]!);
          const body = (await collectBody(req)).toString("utf-8");
          return pipeResponse(res, handleAccountsDisable({ pool: deps.pool }, acctId, body));
        }
        const enableMatch = url.match(ADMIN_ENABLE);
        if (enableMatch) {
          const acctId = decodeURIComponent(enableMatch[1]!);
          return pipeResponse(res, handleAccountsEnable({ pool: deps.pool }, acctId));
        }
      }
      sendJson(res, 404, { error: { type: "not_found", message: `${req.method} ${url} not handled` } });
    } catch (err) {
      console.error("[agent] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { type: "internal_error", message: String(err) } });
      else res.end();
    }
  });
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await collectBody(req);
  try { JSON.parse(body.toString("utf-8")); }
  catch { return sendJson(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }
  const accept = pickHeader(req.headers["accept"]) ?? "application/json";
  const accountHint = pickHeader(req.headers["x-account-hint"]) ?? null;
  const betaHeader = pickHeader(req.headers["anthropic-beta"]) ?? null;
  const upstream = await deps.upstream(body, accept, deps.pool, accountHint, betaHeader);
  await pipeWebResponse(res, upstream);
}

async function handleOllama(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps, url: string): Promise<void> {
  if (!deps.ollama) {
    return sendJson(res, 501, { error: { type: "not_implemented", message: "ollama relay is not enabled on this agent" } });
  }
  const body = await collectBody(req);
  try { JSON.parse(body.toString("utf-8")); }
  catch { return sendJson(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }
  const subpath = url.slice(OLLAMA_PREFIX.length); // "chat/completions" | "embeddings"
  const accept = pickHeader(req.headers["accept"]) ?? "application/json";
  const upstream = await deps.ollama(subpath, body, accept);
  await pipeWebResponse(res, upstream);
}

// Stream a web Response (from fetch) out through a node ServerResponse, dropping
// hop-by-hop headers. Shared by the Anthropic and Ollama relays.
async function pipeWebResponse(res: http.ServerResponse, upstream: Response): Promise<void> {
  res.statusCode = upstream.status;
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
}

async function pipeResponse(res: http.ServerResponse, source: Response): Promise<void> {
  res.statusCode = source.status;
  for (const [k, v] of source.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  const text = await source.text();
  res.end(text);
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
