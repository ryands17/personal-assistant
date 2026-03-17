import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type WorkerInfo } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config, DEFAULT_MODEL } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { resetClient } from "./client.js";
import {
  logConversation, getState, setState, deleteState,
  getMemorySummary, getRecentConversation, getGroupGoal,
} from "../store/db.js";
import { SESSIONS_DIR, SOUL_PATH } from "../paths.js";
import { resolveModel, type Tier, type RouteResult } from "./router.js";
import { readFileSync, existsSync } from "fs";

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Session key for the DM (direct message) orchestrator session */
const DM_SESSION_KEY = "dm";

function sessionStateKey(sessionKey: string): string {
  return `orchestrator_session_${sessionKey}`;
}

/**
 * Read SOUL.md and return a sanitised string of known fields only.
 * Parses bot name, user name, timezone, and personality — no raw content
 * is ever injected as system instructions (guards against prompt injection).
 */
function readSoul(): string | undefined {
  try {
    if (!existsSync(SOUL_PATH)) return undefined;
    const raw = readFileSync(SOUL_PATH, "utf-8");
    const field = (name: string): string => {
      const m = raw.match(new RegExp(`\\*\\*${name}\\*\\*:\\s*(.+)`));
      return m ? m[1].trim().slice(0, 200) : "";
    };
    const botName = field("Bot name");
    const userName = field("User name");
    const timezone = field("Timezone");
    const personality = field("Personality");
    if (!botName && !userName && !timezone && !personality) return undefined;
    return `Bot name: ${botName}\nUser name: ${userName}\nTimezone: ${timezone}\nPersonality: ${personality}`;
  } catch {
    console.warn("[max] Could not read SOUL.md — proceeding without personalisation");
    return undefined;
  }
}


export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "background" };

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific channel
type ProactiveNotifyFn = (text: string, channel?: "telegram" | "tui") => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let copilotClient: CopilotClient | undefined;
const workers = new Map<string, WorkerInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// Router state — tracks model across the session
let currentSessionModel: string | undefined;
let recentTiers: Tier[] = [];
let lastRouteResult: RouteResult | undefined;

export function getLastRouteResult(): RouteResult | undefined {
  return lastRouteResult;
}

// ── Multi-session state ────────────────────────────────────────────────────
// Keyed by session key: "dm" for direct messages, String(chatId) for groups
const orchestratorSessions = new Map<string, CopilotSession>();
const sessionCreatePromises = new Map<string, Promise<CopilotSession>>();

// Per-session message queues
type QueuedMessage = {
  prompt: string;
  callback: MessageCallback;
  sourceChannel?: "telegram" | "tui";
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueues = new Map<string, QueuedMessage[]>();
const processingFlags = new Map<string, boolean>();

let currentCallback: MessageCallback | undefined;
/** Per-session source channel — set while processQueue executes an item for that session. */
const currentSourceChannels = new Map<string, "telegram" | "tui">();

/** Get the channel that originated the message currently being processed for a session. */
export function getCurrentSourceChannel(sessionKey: string): "telegram" | "tui" | undefined {
  return currentSourceChannels.get(sessionKey);
}

function getSessionConfig(sessionKey: string, chatId?: number) {
  const tools = createTools({
    client: copilotClient!,
    workers,
    onWorkerComplete: feedBackgroundResult,
    chatId,
    sessionKey,
  });
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();
  return { tools, mcpServers, skillDirectories };
}

/** Feed a background worker result into the orchestrator as a new turn. */
export function feedBackgroundResult(workerName: string, result: string): void {
  const worker = workers.get(workerName);
  const channel = worker?.originChannel;
  const originChatId = worker?.originChatId;
  const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;

  // Route result back to the session that spawned the worker (group or DM)
  const source: MessageSource = originChatId !== undefined
    ? { type: "telegram", chatId: originChatId, messageId: 0 }
    : { type: "background" };

  sendToOrchestrator(
    prompt,
    source,
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        proactiveNotifyFn(_text, channel);
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the SDK client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<CopilotClient> | undefined;
async function ensureClient(): Promise<CopilotClient> {
  if (copilotClient && copilotClient.getState() === "connected") {
    return copilotClient;
  }
  if (!resetPromise) {
    console.log(`[max] Client not connected (state: ${copilotClient?.getState() ?? "null"}), resetting…`);
    resetPromise = resetClient().then((c) => {
      console.log(`[max] Client reset successful, state: ${c.getState()}`);
      copilotClient = c;
      return c;
    }).finally(() => { resetPromise = undefined; });
  }
  return resetPromise;
}

/** Start periodic health check that proactively reconnects the client. */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!copilotClient) return;
    try {
      const state = copilotClient.getState();
      if (state !== "connected") {
        console.log(`[max] Health check: client state is '${state}', resetting…`);
        await ensureClient();
        // All sessions may need recovery after client reset
        orchestratorSessions.clear();
        currentSessionModel = undefined;
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Create or resume an orchestrator session for a given key. chatId is undefined for DM. */
async function ensureOrchestratorSession(sessionKey: string, chatId?: number): Promise<CopilotSession> {
  const existing = orchestratorSessions.get(sessionKey);
  if (existing) return existing;

  const inFlight = sessionCreatePromises.get(sessionKey);
  if (inFlight) return inFlight;

  const promise = createOrResumeSession(sessionKey, chatId);
  sessionCreatePromises.set(sessionKey, promise);
  try {
    const session = await promise;
    orchestratorSessions.set(sessionKey, session);
    return session;
  } finally {
    sessionCreatePromises.delete(sessionKey);
  }
}

/** Internal: actually create or resume a session. */
async function createOrResumeSession(sessionKey: string, chatId?: number): Promise<CopilotSession> {
  const client = await ensureClient();
  const { tools, mcpServers, skillDirectories } = getSessionConfig(sessionKey, chatId);
  const memorySummary = getMemorySummary(chatId);
  const soulContent = readSoul();
  const groupGoal = chatId !== undefined ? getGroupGoal(chatId) : undefined;

  const infiniteSessions = {
    enabled: true,
    backgroundCompactionThreshold: 0.80,
    bufferExhaustionThreshold: 0.95,
  };

  const systemContent = getOrchestratorSystemMessage(memorySummary || undefined, {
    selfEditEnabled: config.selfEditEnabled,
    soulContent,
    groupGoal,
  });

  const stateKey = sessionStateKey(sessionKey);
  const savedSessionId = getState(stateKey);
  if (savedSessionId) {
    try {
      console.log(`[max] Resuming session '${sessionKey}' (${savedSessionId.slice(0, 8)}…)`);
      const session = await client.resumeSession(savedSessionId, {
        model: config.copilotModel,
        configDir: SESSIONS_DIR,
        streaming: true,
        systemMessage: { content: systemContent },
        tools,
        mcpServers,
        skillDirectories,
        onPermissionRequest: approveAll,
        infiniteSessions,
      });
      console.log(`[max] Resumed session '${sessionKey}' successfully`);
      if (sessionKey === DM_SESSION_KEY) currentSessionModel = config.copilotModel;
      return session;
    } catch (err) {
      console.log(`[max] Could not resume session '${sessionKey}': ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteState(stateKey);
    }
  }

  console.log(`[max] Creating new session '${sessionKey}'`);
  const session = await client.createSession({
    model: config.copilotModel,
    configDir: SESSIONS_DIR,
    streaming: true,
    systemMessage: { content: systemContent },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: approveAll,
    infiniteSessions,
  });
  setState(stateKey, session.sessionId);
  console.log(`[max] Created session '${sessionKey}' (${session.sessionId.slice(0, 8)}…)`);

  // Recover conversation context if available
  const recentHistory = getRecentConversation(10, chatId);
  if (recentHistory) {
    console.log(`[max] Injecting recent conversation context into session '${sessionKey}'`);
    try {
      await session.sendAndWait({
        prompt: `[System: Session recovered] Your previous session was lost. Here's the recent conversation for context — do NOT respond to these messages, just absorb the context silently:\n\n${recentHistory}\n\n(End of recovery context. Wait for the next real message.)`,
      }, 60_000);
    } catch (err) {
      console.log(`[max] Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (sessionKey === DM_SESSION_KEY) currentSessionModel = config.copilotModel;
  return session;
}

/** Destroy a group session (e.g. bot removed from group). */
export function destroyGroupSession(chatId: number): void {
  const sessionKey = String(chatId);
  orchestratorSessions.delete(sessionKey);
  sessionCreatePromises.delete(sessionKey);
  messageQueues.delete(sessionKey);
  processingFlags.delete(sessionKey);
  deleteState(sessionStateKey(sessionKey));
  console.log(`[max] Destroyed session for group ${chatId}`);
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig(DM_SESSION_KEY);

  // Validate configured model against available models
  try {
    const models = await client.listModels();
    const configured = config.copilotModel;
    const isAvailable = models.some((m) => m.id === configured);
    if (!isAvailable) {
      console.log(`[max] ⚠️ Configured model '${configured}' is not available. Falling back to '${DEFAULT_MODEL}'.`);
      config.copilotModel = DEFAULT_MODEL;
    }
  } catch (err) {
    console.log(`[max] Could not validate model (will use '${config.copilotModel}' as-is): ${err instanceof Error ? err.message : err}`);
  }

  console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`[max] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
  console.log(`[max] Persistent session mode — conversation history maintained by SDK`);
  startHealthCheck();

  // Eagerly create/resume the DM orchestrator session
  try {
    await ensureOrchestratorSession(DM_SESSION_KEY, undefined);
  } catch (err) {
    console.error(`[max] Failed to create initial session (will retry on first message):`, err instanceof Error ? err.message : err);
  }
}

/** Send a prompt on the session for the given key, return the response. */
async function executeOnSession(sessionKey: string, chatId: number | undefined, prompt: string, callback: MessageCallback): Promise<string> {
  const session = await ensureOrchestratorSession(sessionKey, chatId);
  currentCallback = callback;

  let accumulated = "";
  let toolCallExecuted = false;
  const unsubToolDone = session.on("tool.execution_complete", () => {
    toolCallExecuted = true;
  });
  const unsubDelta = session.on("assistant.message_delta", (event) => {
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += event.data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait({ prompt }, 300_000);
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      console.log(`[max] Session '${sessionKey}' appears dead, will recreate: ${msg}`);
      orchestratorSessions.delete(sessionKey);
      if (sessionKey === DM_SESSION_KEY) {
        currentSessionModel = undefined;
        deleteState(sessionStateKey(sessionKey));
      } else {
        deleteState(sessionStateKey(sessionKey));
      }
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolDone();
    currentCallback = undefined;
  }
}

/** Get or create the message queue for a session key. */
function getQueue(sessionKey: string): QueuedMessage[] {
  if (!messageQueues.has(sessionKey)) messageQueues.set(sessionKey, []);
  return messageQueues.get(sessionKey)!;
}

/** Process the message queue for a session key, one at a time. */
async function processQueue(sessionKey: string, chatId?: number): Promise<void> {
  if (processingFlags.get(sessionKey)) {
    const queue = getQueue(sessionKey);
    if (queue.length > 0) {
      console.log(`[max] Message queued for '${sessionKey}' (${queue.length} waiting)`);
    }
    return;
  }
  processingFlags.set(sessionKey, true);

  const queue = getQueue(sessionKey);
  while (queue.length > 0) {
    const item = queue.shift()!;
    currentSourceChannels.set(sessionKey, item.sourceChannel!);
    try {
      // Only auto-route for DM session
      if (sessionKey === DM_SESSION_KEY) {
        const routeResult = await resolveModel(item.prompt, currentSessionModel || config.copilotModel, recentTiers, copilotClient);
        if (routeResult.switched) {
          console.log(`[max] Auto: switching to ${routeResult.model} (${routeResult.overrideName || routeResult.tier})`);
          config.copilotModel = routeResult.model;
          orchestratorSessions.delete(DM_SESSION_KEY);
          deleteState(sessionStateKey(DM_SESSION_KEY));
        }
        if (routeResult.tier) {
          recentTiers.push(routeResult.tier);
          if (recentTiers.length > 5) recentTiers = recentTiers.slice(-5);
        }
        lastRouteResult = routeResult;
      }

      const result = await executeOnSession(sessionKey, chatId, item.prompt, item.callback);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    currentSourceChannels.delete(sessionKey);
  }

  processingFlags.set(sessionKey, false);
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback
): Promise<void> {
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" : "background";
  logMessage("in", sourceLabel, prompt);

  // Determine session key: groups (negative chatId) get their own session
  const chatId = source.type === "telegram" ? source.chatId : undefined;
  const isGroup = chatId !== undefined && chatId < 0;
  const sessionKey = isGroup ? String(chatId) : DM_SESSION_KEY;
  const groupChatId = isGroup ? chatId : undefined;

  // Tag the prompt with its source channel
  const taggedPrompt = source.type === "background"
    ? prompt
    : `[via ${sourceLabel}] ${prompt}`;

  const logRole = source.type === "background" ? "system" : "user";

  const sourceChannel: "telegram" | "tui" | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" : undefined;

  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          getQueue(sessionKey).push({ prompt: taggedPrompt, callback, sourceChannel, resolve, reject });
          processQueue(sessionKey, groupChatId);
        });
        callback(finalContent, true);
        try { logMessage("out", sourceLabel, finalContent); } catch { /* best-effort */ }
        try { logConversation(logRole, prompt, sourceLabel, groupChatId); } catch { /* best-effort */ }
        try { logConversation("assistant", finalContent, sourceLabel, groupChatId); } catch { /* best-effort */ }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (/cancelled|abort/i.test(msg)) {
          return;
        }

        if (isRecoverableError(err) && attempt < MAX_RETRIES) {
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
          console.error(`[max] Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          await sleep(delay);
          try { await ensureClient(); } catch { /* will fail again on next attempt */ }
          continue;
        }

        console.error(`[max] Error processing message: ${msg}`);
        callback(`Error: ${msg}`, true);
        return;
      }
    }
  })();
}

/** Cancel the in-flight message and drain the DM queue. */
export async function cancelCurrentMessage(): Promise<boolean> {
  const dmQueue = getQueue(DM_SESSION_KEY);
  const drained = dmQueue.length;
  while (dmQueue.length > 0) {
    const item = dmQueue.shift()!;
    item.reject(new Error("Cancelled"));
  }

  const dmSession = orchestratorSessions.get(DM_SESSION_KEY);
  if (dmSession && currentCallback) {
    try {
      await dmSession.abort();
      console.log(`[max] Aborted in-flight request`);
      return true;
    } catch (err) {
      console.error(`[max] Abort failed:`, err instanceof Error ? err.message : err);
    }
  }

  return drained > 0;
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
