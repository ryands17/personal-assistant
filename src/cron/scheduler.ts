import cron, { type ScheduledTask } from "node-cron";
import { approveAll } from "@github/copilot-sdk";
import { getClient } from "../copilot/client.js";
import { getAllActiveCrons, getCrons, getCronById, updateCronLastRun, updateCronMemory, type CronRow } from "../store/db.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";
import { config } from "../config.js";

// Bot instance is injected after creation so we can send messages when crons fire
let sendMessage: ((chatId: number, text: string) => Promise<void>) | undefined;

export function setCronMessageSender(fn: (chatId: number, text: string) => Promise<void>): void {
  sendMessage = fn;
}

const scheduledTasks = new Map<number, ScheduledTask>();

// Use a smaller/cheaper model for the one-shot cron expression conversion and memory summarisation
const CRON_PARSE_MODEL = "claude-haiku-4.5";

/** Convert a natural language schedule description to a 5-field cron expression using the Copilot API. */
export async function parseSchedule(description: string): Promise<string> {
  const client = await getClient();
  const session = await client.createSession({
    model: CRON_PARSE_MODEL,
    streaming: false,
    systemMessage: {
      content:
        "You are a cron expression converter. " +
        "When given a natural language schedule description, reply with ONLY a valid 5-field cron expression (minute hour day month weekday). " +
        "No explanation, no markdown, no extra text — just the 5 fields separated by spaces. " +
        "Examples: 'every day at 9am' → '0 9 * * *', 'every Monday at 8:30am' → '30 8 * * 1', 'every hour' → '0 * * * *'.",
    },
    onPermissionRequest: approveAll,
  });

  try {
    const result = await session.sendAndWait({ prompt: description }, 30_000);
    const raw = result?.data?.content ?? "";
    const expression = raw.trim().replace(/`/g, "");
    if (!cron.validate(expression)) {
      throw new Error(`AI returned an invalid cron expression: "${expression}"`);
    }
    return expression;
  } finally {
    await session.destroy().catch(() => {});
  }
}

/** The [memory] tag opts a cron into persistent memory. Strip it from the prompt before sending. */
const MEMORY_TAG = "[memory]";

/**
 * After a cron fires, asynchronously summarise the run into the cron's memory column.
 * Non-blocking — fires and forgets so it doesn't delay the Telegram message.
 */
function updateMemoryAsync(cronRow: CronRow, strippedPrompt: string, response: string): void {
  void (async () => {
    try {
      const client = await getClient();
      const session = await client.createSession({
        model: CRON_PARSE_MODEL,
        streaming: false,
        systemMessage: {
          content:
            "You are a memory manager for a recurring AI cron job. " +
            "Given the cron's purpose, its prompt, and the response it produced, " +
            "write a concise updated memory (max 300 words) capturing: current state, " +
            "key facts, progress, and anything useful for the next run. " +
            "Reply with ONLY the updated memory text — no headers, no commentary.",
        },
        onPermissionRequest: approveAll,
      });
      try {
        const previousMemory = cronRow.cron_memory ?? "none";
        const userMessage =
          `Previous memory: ${previousMemory}\n\n` +
          `Cron prompt: ${strippedPrompt}\n\n` +
          `This run's response: ${response}`;
        const result = await session.sendAndWait({ prompt: userMessage }, 30_000);
        const newMemory = result?.data?.content?.trim() ?? "";
        if (newMemory) {
          // Guard against stale writes: if the user cleared memory after this run started,
          // respect that action and skip the update.
          const currentRow = getCronById(cronRow.id);
          if (cronRow.cron_memory !== null && currentRow?.cron_memory === null) {
            console.log(`[cron] Memory update skipped for cron #${cronRow.id} (cleared by user during run)`);
          } else {
            updateCronMemory(cronRow.id, newMemory);
            console.log(`[cron] Memory updated for cron #${cronRow.id}`);
          }
        }
      } finally {
        await session.destroy().catch(() => {});
      }
    } catch (err) {
      console.error(`[cron] Failed to update memory for cron #${cronRow.id}:`, err instanceof Error ? err.message : err);
    }
  })();
}

/** Fire a single cron: run its prompt through the orchestrator and send the reply. */
async function fireCron(cronRow: CronRow): Promise<void> {
  if (!sendMessage) {
    console.warn(`[cron] No message sender configured — skipping cron #${cronRow.id}`);
    return;
  }

  const hasMemory = cronRow.prompt.includes(MEMORY_TAG);
  // Strip the [memory] tag before sending to the AI
  const strippedPrompt = hasMemory ? cronRow.prompt.replace(MEMORY_TAG, "").trim() : cronRow.prompt;

  // Inject stored memory as silent context prefix so the AI can use it without narrating it
  const effectivePrompt =
    hasMemory && cronRow.cron_memory
      ? `[Memory from previous run]\n${cronRow.cron_memory}\n[End of memory]\n\n${strippedPrompt}`
      : strippedPrompt;

  console.log(`[cron] Firing cron #${cronRow.id} for chat ${cronRow.chat_id}: ${strippedPrompt.slice(0, 60)}`);

  const fullResponse = await new Promise<string>((resolve) => {
    let captured = "";
    sendToOrchestrator(
      effectivePrompt,
      { type: "telegram", chatId: cronRow.chat_id, messageId: 0 },
      (text, done) => {
        if (done) {
          captured = text;
          resolve(captured);
        }
      }
    );
    // Safety timeout — resolve with whatever we have
    setTimeout(() => resolve(captured), 120_000);
  });

  if (fullResponse) {
    await sendMessage(cronRow.chat_id, fullResponse).catch((err) => {
      console.error(`[cron] Failed to send cron #${cronRow.id} response:`, err instanceof Error ? err.message : err);
    });
    // Stamp last_run only after the message is successfully sent
    updateCronLastRun(cronRow.id);
    // If memory is enabled, asynchronously update the memory column (non-blocking)
    if (hasMemory) {
      updateMemoryAsync(cronRow, strippedPrompt, fullResponse);
    }
  }
}

/** Schedule a single cron row as a node-cron task. */
function scheduleTask(cronRow: CronRow): void {
  // Stop any existing task for this ID before rescheduling (idempotency)
  const existing = scheduledTasks.get(cronRow.id);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(cronRow.id);
  }

  const timezone = config.timezone || "UTC";
  try {
    const task = cron.schedule(
      cronRow.cron_expression,
      () => { void fireCron(cronRow); },
      { timezone }
    );
    scheduledTasks.set(cronRow.id, task);
    console.log(`[cron] Scheduled cron #${cronRow.id} (${cronRow.cron_expression}) for chat ${cronRow.chat_id}`);
  } catch (err) {
    console.error(`[cron] Failed to schedule cron #${cronRow.id}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Load all active crons from DB and start scheduling them. */
export function init(): void {
  const rows = getAllActiveCrons();
  for (const row of rows) {
    scheduleTask(row);
  }
  console.log(`[cron] Initialized ${rows.length} cron(s)`);
}

/** Add a newly created cron to the scheduler. */
export function add(cronRow: CronRow): void {
  scheduleTask(cronRow);
}

/** Remove a cron from the scheduler (stop + delete from map). */
export function remove(id: number): void {
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
    console.log(`[cron] Removed cron #${id}`);
  }
}

/** Pause a cron (stop the task without deleting it from DB). */
export function pause(id: number): void {
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
    console.log(`[cron] Paused cron #${id}`);
  }
}

/** Resume a paused cron by reloading it from DB. */
export function resume(cronId: number, chatId: number): void {
  const rows = getCrons(chatId);
  const row = rows.find((r) => r.id === cronId);
  if (row && !scheduledTasks.has(cronId)) {
    scheduleTask(row);
    console.log(`[cron] Resumed cron #${cronId}`);
  }
}

/** Update a cron's schedule by stopping the old task and rescheduling with the new expression. */
export function updateSchedule(cronRow: CronRow): void {
  const existing = scheduledTasks.get(cronRow.id);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(cronRow.id);
  }
  if (!cronRow.paused) {
    scheduleTask(cronRow);
    console.log(`[cron] Rescheduled cron #${cronRow.id} with expression: ${cronRow.cron_expression}`);
  }
}

/** Return the next scheduled run time for a cron, or null if paused/not scheduled. */
export function getNextRun(id: number): Date | null {
  const task = scheduledTasks.get(id);
  if (!task) return null;
  try {
    return task.getNextRun() ?? null;
  } catch {
    return null;
  }
}

/** Return the last run time for a cron from the DB, or null if it has never fired. */
export function getPreviousRun(id: number): Date | null {
  const row = getCronById(id);
  if (!row?.last_run) return null;
  const d = new Date(row.last_run);
  return isNaN(d.getTime()) ? null : d;
}
