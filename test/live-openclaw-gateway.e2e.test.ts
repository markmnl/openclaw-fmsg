import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FmsgClient } from "../src/client.js";
import type { FmsgMessage } from "../src/types.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

const enabled = process.env.OPENCLAW_GATEWAY_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startModelServer() {
  let replyNumber = 0;
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const input = await body(request);
      requests.push(input);
      const text = `gateway reply ${++replyNumber}`;
      const id = `chatcmpl-fmsg-${replyNumber}`;
      if (input.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gateway-test",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }));
        return;
      }
      const events = [
        {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gateway-test",
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        },
        {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gateway-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        },
      ];
      const output = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(output),
      });
      response.end(output);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function draftRequests(server: FakeFmsgServer) {
  return server.requests.filter((request) => request.method === "POST" && request.path === "/fmsg");
}

const processes: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode == null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe.skipIf(!enabled)("live OpenClaw gateway", () => {
  it("creates native branch sessions and sends reply-all through the channel plugin", async () => {
    const openclawRoot = process.env.OPENCLAW_E2E_ROOT
      ? path.resolve(process.env.OPENCLAW_E2E_ROOT)
      : path.resolve(repoRoot, "node_modules/openclaw");
    const pluginRoot = process.env.OPENCLAW_E2E_PLUGIN_ROOT
      ? path.resolve(process.env.OPENCLAW_E2E_PLUGIN_ROOT)
      : repoRoot;
    const cli = path.join(openclawRoot, "openclaw.mjs");
    const fmsg = new FakeFmsgServer();
    const model = await startModelServer();
    await fmsg.start();
    const temporary = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-gateway-"));
    tempDirs.push(temporary);
    const stateDir = path.join(temporary, "state");
    const workspace = path.join(temporary, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = path.join(temporary, "openclaw.json");
    const port = await unusedPort();
    const secretsPath = path.join(temporary, "secrets.json");
    await writeFile(secretsPath, JSON.stringify({
      fmsg: { apiKey: "fmsgk_agent-test" },
      model: { apiKey: "test-model-key" },
    }));
    await chmod(secretsPath, 0o600);
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "none" } },
      secrets: {
        providers: {
          "fmsg-test": { source: "file", path: secretsPath, mode: "json" },
        },
      },
      agents: {
        defaults: {
          workspace,
          model: { primary: "fmsg-test/gateway-test" },
          models: { "fmsg-test/gateway-test": {} },
        },
      },
      models: {
        mode: "merge",
        providers: {
          "fmsg-test": {
            baseUrl: `${model.url}/v1`,
            apiKey: { source: "file", provider: "fmsg-test", id: "/model/apiKey" },
            api: "openai-completions",
            models: [{
              id: "gateway-test",
              name: "fmsg gateway test",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_768,
              maxTokens: 2_048,
            }],
          },
        },
      },
      plugins: {
        allow: ["fmsg"],
        load: { paths: [pluginRoot] },
        entries: { fmsg: { enabled: true } },
      },
      channels: {
        fmsg: {
          enabled: true,
          apiUrl: fmsg.url,
          apiKey: { source: "file", provider: "fmsg-test", id: "/fmsg/apiKey" },
          homeChannel: "@alice@example.net",
          allowedUsers: ["@alice@example.net"],
          maxAgentTurnsPerThread: 8,
          maxAgentTurnsPerRoot: 20,
          maxAgentTurnsPerSender: 20,
          agentTurnWindowMs: 60_000,
        },
      },
    }, null, 2));

    const {
      FMSG_API_KEY: _ignoredFmsgApiKey,
      FMSG_API_URL: _ignoredFmsgApiUrl,
      FMSG_HOME_CHANNEL: _ignoredFmsgHomeChannel,
      ...gatewayEnv
    } = process.env;
    const commandEnv = {
      ...gatewayEnv,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };
    const audit = spawnSync(process.execPath, [cli, "secrets", "audit", "--check", "--json"], {
      cwd: temporary,
      env: commandEnv,
      encoding: "utf8",
    });
    expect(audit.status, `${audit.stdout}\n${audit.stderr}`).toBe(0);
    const child = spawn(process.execPath, [
      cli,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--verbose",
    ], {
      cwd: temporary,
      env: commandEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    processes.push(child);
    let logs = "";
    child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
    child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
    try {
      await waitFor(
        () => logs.includes("[fmsg] connected") && fmsg.connectedClientCount("@agent@example.com") > 0
          ? true
          : undefined,
        "the fmsg gateway connection",
      );
      expect(logs).toContain("[fmsg] connected as @agent@example.com");
      const root = fmsg.seedMessage({
        id: "100",
        from: "@alice@example.net",
        to: ["@agent@example.com", "@bob@example.org"],
        add_to: [{ add_to_from: "@alice@example.net", to: ["@carol@example.org"] }],
        topic: "live gateway acceptance",
        data: "root message",
      });
      fmsg.pushNewMessage(root);
      const rootReply = await waitFor(
        () => draftRequests(fmsg).find((request) => (request.body as { pid?: number } | undefined)?.pid === 100),
        "the root reply",
      );
      expect(JSON.stringify(model.requests[0])).toContain("participants other than this OpenClaw address");
      expect(JSON.stringify(model.requests[0])).toContain("@bob@example.org");
      expect(JSON.stringify(model.requests[0])).toContain("@carol@example.org");
      expect((rootReply.body as FmsgMessage).to).toEqual([
        "@alice@example.net",
        "@bob@example.org",
        "@carol@example.org",
      ]);
      // Fake server assigns the next numeric id; read it back from the matching sent message.
      const actualRootReply = await waitFor(
        () => [...Array(20).keys()].map((offset) => fmsg.getMessage(String(101 + offset)))
          .find((message) => message?.pid === "100"),
        "the stored root reply",
      );

      const peerClient = new FmsgClient(fmsg.url, "fmsgk_alice-test", { refreshMarginMs: 0 });
      const modelRequestsBeforeReaction = model.requests.length;
      await peerClient.reactToMessage(actualRootReply.id, "👍");
      await waitFor(() => {
        try {
          const snapshot = JSON.parse(
            readFileSync(path.join(stateDir, "fmsg", "default.json"), "utf8"),
          ) as { reactionSnapshots?: Record<string, { bySender?: Record<string, string> }> };
          return snapshot.reactionSnapshots?.[actualRootReply.id]?.bySender?.["@alice@example.net"] === "👍"
            ? true
            : undefined;
        } catch {
          return undefined;
        }
      }, "the persisted inbound reaction");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(model.requests).toHaveLength(modelRequestsBeforeReaction);

      const firstChild = fmsg.seedMessage({
        id: "200",
        pid: actualRootReply.id,
        has_pid: true,
        from: "@alice@example.net",
        to: ["@agent@example.com", "@bob@example.org"],
        data: "first child",
      });
      fmsg.pushNewMessage(firstChild);
      await waitFor(
        () => draftRequests(fmsg).find((request) => (request.body as { pid?: number } | undefined)?.pid === 200),
        "the first-child reply",
      );

      const sibling = fmsg.seedMessage({
        id: "300",
        pid: actualRootReply.id,
        has_pid: true,
        from: "@alice@example.net",
        to: ["@agent@example.com", "@bob@example.org"],
        data: "later sibling branch",
      });
      fmsg.pushNewMessage(sibling);
      await waitFor(
        () => draftRequests(fmsg).find((request) => (request.body as { pid?: number } | undefined)?.pid === 300),
        "the sibling-branch reply",
      );

      const fmsgState = JSON.parse(await readFile(path.join(stateDir, "fmsg", "default.json"), "utf8")) as {
        messages: Record<string, { branchId: string }>;
      };
      expect(fmsgState.messages["100"]?.branchId).toBe("100");
      expect(fmsgState.messages["200"]?.branchId).toBe("100");
      expect(fmsgState.messages["300"]?.branchId).toBe("100:br:300");

      const sessionDatabase = new DatabaseSync(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        { readOnly: true },
      );
      const sessionKeys = (sessionDatabase.prepare(
        "SELECT session_key FROM session_nodes ORDER BY session_key",
      ).all() as Array<{ session_key: string }>).map((row) => row.session_key);
      sessionDatabase.close();
      expect(sessionKeys).toContain(
        "agent:main:fmsg:direct:@alice@example.net:thread:100",
      );
      expect(sessionKeys).toContain(
        "agent:main:fmsg:direct:@alice@example.net:thread:100:br:300",
      );
      expect(model.requests.length).toBeGreaterThanOrEqual(3);

      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([
        stopped,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("gateway did not stop for restart acceptance")), 10_000),
        ),
      ]);
      fmsg.seedMessage({
        id: "400",
        from: "@alice@example.net",
        to: ["@agent@example.com"],
        data: "arrived while gateway was stopped",
      });
      const restarted = spawn(process.execPath, [
        cli,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--auth",
        "none",
        "--verbose",
      ], {
        cwd: temporary,
        env: commandEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      processes.push(restarted);
      let restartLogs = "";
      restarted.stdout.on("data", (chunk) => { restartLogs += chunk.toString(); });
      restarted.stderr.on("data", (chunk) => { restartLogs += chunk.toString(); });
      await waitFor(
        () => restartLogs.includes("[fmsg] connected as @agent@example.com")
          ? true
          : undefined,
        "the restarted fmsg gateway connection",
      );
      await waitFor(
        () => draftRequests(fmsg).find(
          (request) => (request.body as { pid?: number } | undefined)?.pid === 400,
        ),
        "the inbox catch-up reply after restart",
      );
      await waitFor(
        () => restartLogs.includes("[fmsg] inbox catch-up complete (1 message, ")
          ? true
          : undefined,
        "the completed inbox catch-up",
      );
    } catch (error) {
      throw new Error(`${String(error)}\nOpenClaw gateway logs:\n${logs}`);
    } finally {
      child.kill("SIGTERM");
      await fmsg.stop();
      await model.stop();
    }
  }, 90_000);
});
