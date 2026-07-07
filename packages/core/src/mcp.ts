// Bring-Your-Own-Tools, live edition: talk MCP over stdio to a real server and pull its tool catalog,
// so `loadTools` can audit the exact schema the server ships — no hand-copied JSON, zero model calls.
// This speaks JSON-RPC 2.0 by hand (initialize -> notifications/initialized -> paged tools/list) and
// makes NO shell out of the user's command: tokenizeCommand splits on whitespace honoring quotes only,
// and spawn runs with shell:false. Pure funcs (tokenize/normalize/toToolsFile) are deterministic; only
// fetchMcpTools does IO, and even it takes retrieved_at from the caller so provenance is stampable.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LOOPWARD_VERSION } from './manifest.ts';

// A fixed, obviously-fake time so deterministic paths never leak wall-clock. The CLI passes the real one.
export const RETRIEVED_AT_SENTINEL = '1970-01-01T00:00:00.000Z';

export interface McpTool { name: string; description: string; inputSchema?: any }
export interface McpToolsResult {
  tools: McpTool[];
  serverInfo?: any;
  protocolVersion?: string;
}

/** Split a command line into argv the way a shell would for the simple cases — whitespace-separated,
 *  with single and double quotes grouping tokens — but WITHOUT invoking a shell or expanding anything
 *  (no globbing, no $VAR, no operators). ponytail: backslash escapes only the two quote chars and space,
 *  which is enough for real MCP launch commands; we don't reimplement POSIX word-splitting. */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false; // did we open a token (so '' quoted args survive)
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) { cur += cmd[++i]; continue; }
      cur += c; has = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === "'" || cmd[i + 1] === ' ' || cmd[i + 1] === '\\')) {
      cur += cmd[++i]; has = true; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c; has = true;
  }
  if (quote) throw new Error(`unbalanced ${quote} quote in command: ${cmd}`);
  if (has) out.push(cur);
  return out;
}

/** Drill a saved tools/list-shaped JSON (either the raw JSON-RPC response {result:{tools}} or a bare
 *  {tools}) down to the tool array, tolerating either wrapper. */
export function normalizeSavedToolsList(json: any): McpToolsResult {
  const tools: McpTool[] = json?.result?.tools ?? json?.tools ?? [];
  return {
    tools,
    serverInfo: json?.result?.serverInfo ?? json?.serverInfo,
    protocolVersion: json?.result?.protocolVersion ?? json?.protocolVersion,
  };
}

/** Wrap a fetched/normalized result into the on-disk tools file that `loadTools` reads (it takes the
 *  flat {tools:[{name,description}]} and ignores the _source provenance block). retrieved_at is passed
 *  in — this function never reads the clock — so the artifact is reproducible byte-for-byte. */
export function toToolsFile(result: McpToolsResult, source: string, retrieved_at: string = RETRIEVED_AT_SENTINEL): object {
  const tools = (result.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
  }));
  // Hash the FULL tool objects (name + description + inputSchema), sorted by name — not just the names.
  // A names-only hash would report "unchanged" when a description or schema was poisoned, exactly the
  // drift this provenance field is supposed to catch.
  const canon = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sha256 = createHash('sha256').update(JSON.stringify(canon)).digest('hex');
  return {
    _source: {
      mcp_server: source,
      server_info: result.serverInfo,
      protocol_version: result.protocolVersion,
      retrieved_at,
      tool_count: tools.length,
      sha256,
    },
    tools,
  };
}

interface FetchOpts {
  timeoutMs?: number;
  protocol?: string;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Spawn an MCP stdio server, run the JSON-RPC handshake, and return its full (paginated) tool list.
 *  Makes ZERO model calls. Rejects on: spawn error (ENOENT), non-zero exit, JSON-RPC error, timeout,
 *  stdout exceeding maxBytes, or a server that reports zero tools. */
export function fetchMcpTools(command: string, opts: FetchOpts = {}): Promise<McpToolsResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const protocolVersion = opts.protocol ?? '2025-06-18';
  const argv = tokenizeCommand(command);

  return new Promise<McpToolsResult>((resolve, reject) => {
    if (argv.length === 0) { reject(new Error(`empty MCP command: ${command}`)); return; }

    let settled = false;
    let stderr = '';
    let buf = '';
    let bytes = 0;
    let nextId = 2;                 // 1 is reserved for initialize
    let serverInfo: any;
    let serverProtocol: string | undefined;
    const collected: McpTool[] = [];

    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      cwd: opts.cwd,
    });

    const timer = setTimeout(() => {
      fail(new Error(`MCP server '${command}' timed out after ${timeoutMs}ms${stderr ? ` (stderr: ${stderr.trim().slice(-500)})` : ''}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      try { child.unref(); } catch { /* nothing to unref */ }
    }
    function fail(err: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function done(result: McpToolsResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function send(msg: object) {
      if (settled) return;
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (e) { fail(new Error(`failed to write to MCP server: ${(e as Error).message}`)); }
    }
    function requestPage(cursor?: string) {
      const id = nextId++;
      pendingListId = id;
      send({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} });
    }

    let pendingListId = -1;

    function handle(msg: any) {
      // notifications (no id) and responses to ids we aren't waiting on are ignored.
      if (msg == null || typeof msg !== 'object' || msg.id == null) return;
      if (msg.error) {
        fail(new Error(`MCP server JSON-RPC error (id ${msg.id}): ${JSON.stringify(msg.error)}`));
        return;
      }
      if (msg.id === 1) {
        serverInfo = msg.result?.serverInfo;
        serverProtocol = msg.result?.protocolVersion ?? protocolVersion;
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        requestPage();
        return;
      }
      if (msg.id === pendingListId) {
        const page: McpTool[] = msg.result?.tools ?? [];
        for (const t of page) collected.push(t);
        const cursor = msg.result?.nextCursor;
        if (cursor) { requestPage(String(cursor)); return; }
        if (collected.length === 0) {
          fail(new Error(`MCP server '${command}' returned zero tools`));
          return;
        }
        done({ tools: collected, serverInfo, protocolVersion: serverProtocol });
      }
    }

    child.on('error', (e) => fail(new Error(`failed to spawn MCP server '${argv[0]}': ${e.message}`)));
    // 'close' (not 'exit'): 'exit' can fire while buffered stdout 'data' is still unprocessed, so a server
    // that writes tools/list then exit(0)s was misreported as "closed before completing". 'close' fires
    // only after stdio has drained; we ALSO flush any final line written without a trailing newline.
    child.on('close', (code, signal) => {
      if (settled) return;
      const tail = buf.trim();
      if (tail) {
        buf = '';
        let msg: any;
        try { msg = JSON.parse(tail); } catch { msg = undefined; }
        if (msg !== undefined) { handle(msg); if (settled) return; }
      }
      if (code && code !== 0) {
        fail(new Error(`MCP server '${command}' exited with code ${code}${stderr ? ` (stderr: ${stderr.trim().slice(-500)})` : ''}`));
      } else {
        fail(new Error(`MCP server '${command}' closed before completing tools/list${signal ? ` (signal ${signal})` : ''}`));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr += d; if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { fail(new Error(`MCP server '${command}' exceeded ${maxBytes} byte stdout cap`)); return; }
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; } // partial/interleaved noise: skip until a clean line
        handle(msg);
        if (settled) return;
      }
    });

    // kick off the handshake
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'loopward', version: LOOPWARD_VERSION },
      },
    });
  });
}
