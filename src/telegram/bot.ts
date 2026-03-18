import { Bot, type Context } from "grammy";
import { config, persistModel } from "../config.js";
import { sendToOrchestrator, cancelCurrentMessage, getWorkers, getLastRouteResult, destroyGroupSession } from "../copilot/orchestrator.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";
import { searchMemories, isGroupAllowed, addGroupAllowlist, removeGroupAllowlist, getGroupAllowlist, setGroupGoal, getGroupGoal, setGroupModel, getGroupModel, createCron, getCrons, getCronById, deleteCron, setCronPaused, updateCronPrompt, updateCronSchedule } from "../store/db.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import * as cronScheduler from "../cron/scheduler.js";

let bot: Bot | undefined;

/** Returns true if a message is from a group/supergroup. */
function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export function createBot(): Bot {
  if (!config.telegramBotToken) {
    throw new Error("Telegram bot token is missing. Run 'max setup' and enter the bot token from @BotFather.");
  }
  if (config.authorizedUserId === undefined) {
    throw new Error("Telegram user ID is missing. Run 'max setup' and enter your Telegram user ID (get it from @userinfobot).");
  }
  bot = new Bot(config.telegramBotToken);

  // ── Handle bot being removed from a group — must be registered BEFORE auth middleware ──
  bot.on("my_chat_member", async (ctx) => {
    const newStatus = ctx.myChatMember.new_chat_member.status;
    const chatId = ctx.chat.id;
    if (newStatus === "left" || newStatus === "kicked") {
      destroyGroupSession(chatId);
      console.log(`[max] Bot removed from group ${chatId}, session destroyed`);
    }
  });

  // Auth middleware
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;

    if (isGroupChat(ctx)) {
      // In groups: check per-group allowlist (owner is always allowed)
      const chatId = ctx.chat!.id;
      if (!isGroupAllowed(chatId, fromId, config.authorizedUserId!)) {
        return; // Silently ignore non-allowed users
      }
    } else {
      // In DMs: only the authorized user
      if (config.authorizedUserId !== undefined && fromId !== config.authorizedUserId) {
        return;
      }
    }
    await next();
  });

  // /start and /help
  bot.command("start", (ctx) => ctx.reply("Max is online. Send me anything."));
  bot.command("help", async (ctx) => {
    const isGroup = isGroupChat(ctx);
    const groupCommands = isGroup ? "\n/allow <userId> — Add user to this group's allowlist\n/deny <userId> — Remove user from allowlist\n/allowlist — List allowed users\n/goal — Show this group's goal\n/model [name] — Show or set this group's model" : "";
    await ctx.reply(
      "I'm Max, your AI daemon.\n\n" +
        "Just send me a message and I'll handle it.\n\n" +
        "Commands:\n" +
        "/cancel — Cancel the current message\n" +
        "/model — Show current model\n" +
        "/model <name> — Switch model\n" +
        "/memory — Show stored memories\n" +
        "/skills — List installed skills\n" +
        "/workers — List active worker sessions\n" +
        "/restart — Restart Max\n" +
        "/help — Show this help" +
        groupCommands
    );
  });
  bot.command("cancel", async (ctx) => {
    if (ctx.from?.id !== config.authorizedUserId) return;
    const cancelled = await cancelCurrentMessage();
    await ctx.reply(cancelled ? "⛔ Cancelled." : "Nothing to cancel.");
  });
  bot.command("model", async (ctx) => {
    if (ctx.from?.id !== config.authorizedUserId) return;
    const arg = ctx.match?.trim();
    const isGroup = isGroupChat(ctx);
    const chatId = isGroup ? ctx.chat!.id : undefined;

    if (!arg) {
      // Show current model for this context
      if (isGroup) {
        const groupModel = getGroupModel(chatId!);
        await ctx.reply(groupModel
          ? `Group model: ${groupModel}`
          : `No group model set — using global default: ${config.copilotModel}`);
      } else {
        await ctx.reply(`Current model: ${config.copilotModel}`);
      }
      return;
    }

    // "default" clears the group model override (group only)
    if (arg === "default") {
      if (!isGroup) {
        await ctx.reply("The default model is set via the global config. Use /model <name> in DM to change it.");
        return;
      }
      const previous = getGroupModel(chatId!) ?? config.copilotModel;
      setGroupModel(chatId!, null);
      destroyGroupSession(chatId!);
      await ctx.reply(`Group model cleared — reverting to global default (${config.copilotModel}).\n\n_Was: ${previous}. Session reset._`);
      return;
    }

    // Validate model
    try {
      const { getClient } = await import("../copilot/client.js");
      const client = await getClient();
      const models = await client.listModels();
      const match = models.find((m) => m.id === arg);
      if (!match) {
        const suggestions = models
          .filter((m) => m.id.includes(arg) || m.id.toLowerCase().includes(arg.toLowerCase()))
          .map((m) => m.id);
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
        await ctx.reply(`Model '${arg}' not found.${hint}`);
        return;
      }
    } catch {
      // allow anyway if validation fails
    }

    if (isGroup) {
      // Set per-group model and destroy session so next message recreates with new model
      const previous = getGroupModel(chatId!) ?? config.copilotModel;
      setGroupModel(chatId!, arg);
      destroyGroupSession(chatId!);
      await ctx.reply(`Group model: ${previous} → ${arg}\n\n_Session reset — next message will use the new model._`);
    } else {
      // DM: set global model
      const previous = config.copilotModel;
      config.copilotModel = arg;
      persistModel(arg);
      await ctx.reply(`Model: ${previous} → ${arg}`);
    }
  });
  bot.command("memory", async (ctx) => {
    const chatId = isGroupChat(ctx) ? ctx.chat!.id : undefined;
    const memories = searchMemories(undefined, undefined, 50, chatId);
    if (memories.length === 0) {
      await ctx.reply("No memories stored.");
    } else {
      const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
      await ctx.reply(lines.join("\n") + `\n\n${memories.length} total`);
    }
  });
  bot.command("skills", async (ctx) => {
    const skills = listSkills();
    if (skills.length === 0) {
      await ctx.reply("No skills installed.");
    } else {
      const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  bot.command("workers", async (ctx) => {
    const workers = Array.from(getWorkers().values());
    if (workers.length === 0) {
      await ctx.reply("No active worker sessions.");
    } else {
      const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  bot.command("restart", async (ctx) => {
    if (ctx.from?.id !== config.authorizedUserId) return;
    await ctx.reply("⏳ Restarting Max...");
    setTimeout(() => {
      restartDaemon().catch((err) => {
        console.error("[max] Restart failed:", err);
      });
    }, 500);
  });

  // ── Group management commands (owner-only) ──────────────────────────────
  bot.command("goal", async (ctx) => {
    if (!isGroupChat(ctx)) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    const chatId = ctx.chat!.id;
    const goal = getGroupGoal(chatId);
    await ctx.reply(goal ? `📌 Group goal:\n\n${goal}` : "No goal set for this group. Send the first message to set one.");
  });

  bot.command("allow", async (ctx) => {
    if (!isGroupChat(ctx)) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    if (ctx.from?.id !== config.authorizedUserId) {
      return; // Only owner can manage allowlist
    }
    const arg = ctx.match?.trim();
    if (!arg) {
      await ctx.reply("Usage: /allow <userId>");
      return;
    }
    const userId = parseInt(arg, 10);
    if (isNaN(userId) || userId <= 0) {
      await ctx.reply("Please provide a valid numeric user ID.");
      return;
    }
    addGroupAllowlist(ctx.chat!.id, userId);
    await ctx.reply(`✅ User ${userId} added to this group's allowlist.`);
  });

  bot.command("deny", async (ctx) => {
    if (!isGroupChat(ctx)) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    if (ctx.from?.id !== config.authorizedUserId) {
      return;
    }
    const arg = ctx.match?.trim();
    if (!arg) {
      await ctx.reply("Usage: /deny <userId>");
      return;
    }
    const userId = parseInt(arg, 10);
    if (isNaN(userId) || userId <= 0) {
      await ctx.reply("Please provide a valid numeric user ID.");
      return;
    }
    const removed = removeGroupAllowlist(ctx.chat!.id, userId);
    await ctx.reply(removed ? `🚫 User ${userId} removed from allowlist.` : `User ${userId} was not in the allowlist.`);
  });

  bot.command("allowlist", async (ctx) => {
    if (!isGroupChat(ctx)) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    if (ctx.from?.id !== config.authorizedUserId) {
      return;
    }
    const chatId = ctx.chat!.id;
    const list = getGroupAllowlist(chatId);
    const ownerLine = `• ${config.authorizedUserId} (owner — always allowed)`;
    if (list.length === 0) {
      await ctx.reply(`Allowlist for this group:\n${ownerLine}\n\nNo additional users added.`);
    } else {
      const lines = list.map((u) => `• ${u.userId}${u.username ? ` (@${u.username})` : ""}`);
      await ctx.reply(`Allowlist for this group:\n${ownerLine}\n${lines.join("\n")}`);
    }
  });

  // ── Cron management (owner-only) ────────────────────────────────────────────
  bot.command("cron", async (ctx) => {
    if (ctx.from?.id !== config.authorizedUserId) return;

    const chatId = ctx.chat!.id;
    const raw = ctx.match?.trim() ?? "";

    // If the input contains a pipe, it's always a create command — check first
    // to avoid subcommand keywords in the schedule (e.g. "list tasks every day | …")
    const pipeIndex = raw.indexOf("|");
    if (pipeIndex !== -1) {
      const scheduleDescription = raw.slice(0, pipeIndex).trim();
      const prompt = raw.slice(pipeIndex + 1).trim();

      if (!scheduleDescription || !prompt) {
        await ctx.reply("Both a schedule and a prompt are required.\n\nExample: `/cron every morning at 9am | Give me a brief summary of the day`", { parse_mode: "Markdown" });
        return;
      }

      const processingMsg = await ctx.reply("⏳ Parsing schedule...");

      let cronExpression: string;
      try {
        cronExpression = await cronScheduler.parseSchedule(scheduleDescription);
      } catch (err) {
        await ctx.api.editMessageText(chatId, processingMsg.message_id, `❌ Could not parse schedule: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const id = createCron(chatId, scheduleDescription, cronExpression, prompt);
      const rows = getCrons(chatId);
      const newRow = rows.find((r) => r.id === id)!;
      cronScheduler.add(newRow);

      const timezone = config.timezone || "UTC";
      await ctx.api.editMessageText(
        chatId,
        processingMsg.message_id,
        `✅ Cron #${id} created\n\n📅 Schedule: ${scheduleDescription}\n🕐 Expression: \`${cronExpression}\` (${timezone})\n💬 Prompt: ${prompt}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const [subcommand, ...rest] = raw.split(/\s+/);

    // /cron list
    if (subcommand === "list") {
      const rows = getCrons(chatId);
      if (rows.length === 0) {
        await ctx.reply("No crons set up for this chat.");
        return;
      }
      const tz = config.timezone || "UTC";
      const fmt = (d: Date) => d.toLocaleString("en-GB", { timeZone: tz, hour12: false, dateStyle: "short", timeStyle: "short" });
      const lines = rows.map((r) => {
        const status = r.paused ? "⏸ paused" : "▶ active";
        const nextRun = !r.paused ? cronScheduler.getNextRun(r.id) : null;
        // Use r.last_run directly from the already-fetched row (avoids N+1 DB reads)
        const prevRun = r.last_run ? new Date(r.last_run) : null;
        const nextLine = nextRun ? `  ⏭ Next:  ${fmt(nextRun)}` : "";
        const prevLine = prevRun && !isNaN(prevRun.getTime()) ? `  ⏮ Last:  ${fmt(prevRun)}` : "";
        // Plain text — no parse_mode to avoid Markdown injection from user-provided prompts/schedules
        return `#${r.id} [${status}] ${r.cron_expression}\n  📋 ${r.schedule_description}\n  💬 ${r.prompt.slice(0, 80)}${r.prompt.length > 80 ? "…" : ""}${nextLine ? `\n${nextLine}` : ""}${prevLine ? `\n${prevLine}` : ""}`;
      });
      await ctx.reply(`Crons for this chat:\n\n${lines.join("\n\n")}`);
      return;
    }

    // /cron edit <id> prompt | <new prompt>
    // /cron edit <id> schedule | <new schedule description>
    if (subcommand === "edit") {
      const id = parseInt(rest[0] ?? "", 10);
      if (isNaN(id)) {
        await ctx.reply("Usage:\n  `/cron edit <id> prompt | <new prompt>`\n  `/cron edit <id> schedule | <new schedule>`", { parse_mode: "Markdown" });
        return;
      }

      const afterId = rest.slice(1).join(" ");
      const editPipeIndex = afterId.indexOf("|");
      if (editPipeIndex === -1) {
        await ctx.reply("Usage:\n  `/cron edit <id> prompt | <new prompt>`\n  `/cron edit <id> schedule | <new schedule>`", { parse_mode: "Markdown" });
        return;
      }

      const field = afterId.slice(0, editPipeIndex).trim().toLowerCase();
      const value = afterId.slice(editPipeIndex + 1).trim();

      if (!value) {
        await ctx.reply("The new value cannot be empty.");
        return;
      }

      if (field === "prompt") {
        const updated = updateCronPrompt(id, chatId, value);
        if (!updated) {
          await ctx.reply(`Cron #${id} not found in this chat.`);
          return;
        }
        await ctx.reply(`✅ Cron #${id} prompt updated.\n\n💬 ${value}`);
        return;
      }

      if (field === "schedule") {
        const processingMsg = await ctx.reply("⏳ Parsing new schedule...");
        let cronExpression: string;
        try {
          cronExpression = await cronScheduler.parseSchedule(value);
        } catch (err) {
          await ctx.api.editMessageText(chatId, processingMsg.message_id, `❌ Could not parse schedule: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const updated = updateCronSchedule(id, chatId, value, cronExpression);
        if (!updated) {
          await ctx.api.editMessageText(chatId, processingMsg.message_id, `Cron #${id} not found in this chat.`);
          return;
        }
        const row = getCronById(id);
        if (row) cronScheduler.updateSchedule(row);
        const timezone = config.timezone || "UTC";
        await ctx.api.editMessageText(
          chatId,
          processingMsg.message_id,
          `✅ Cron #${id} schedule updated.\n\n📅 ${value}\n🕐 \`${cronExpression}\` (${timezone})`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      await ctx.reply("Field must be `prompt` or `schedule`.", { parse_mode: "Markdown" });
      return;
    }

    // /cron delete <id>
    if (subcommand === "delete") {
      const id = parseInt(rest[0] ?? "", 10);
      if (isNaN(id)) {
        await ctx.reply("Usage: /cron delete <id>");
        return;
      }
      const deleted = deleteCron(id, chatId);
      if (deleted) {
        cronScheduler.remove(id);
        await ctx.reply(`Cron #${id} deleted.`);
      } else {
        await ctx.reply(`Cron #${id} not found in this chat.`);
      }
      return;
    }

    // /cron pause <id>
    if (subcommand === "pause") {
      const id = parseInt(rest[0] ?? "", 10);
      if (isNaN(id)) {
        await ctx.reply("Usage: /cron pause <id>");
        return;
      }
      const updated = setCronPaused(id, chatId, true);
      if (updated) {
        cronScheduler.pause(id);
        await ctx.reply(`Cron #${id} paused.`);
      } else {
        await ctx.reply(`Cron #${id} not found in this chat.`);
      }
      return;
    }

    // /cron resume <id>
    if (subcommand === "resume") {
      const id = parseInt(rest[0] ?? "", 10);
      if (isNaN(id)) {
        await ctx.reply("Usage: /cron resume <id>");
        return;
      }
      const updated = setCronPaused(id, chatId, false);
      if (updated) {
        cronScheduler.resume(id, chatId);
        await ctx.reply(`Cron #${id} resumed.`);
      } else {
        await ctx.reply(`Cron #${id} not found in this chat.`);
      }
      return;
    }

    // No pipe and no recognized subcommand — show usage
    await ctx.reply(
      "Usage:\n" +
      "  `/cron <schedule> | <prompt>` — create a cron\n" +
      "  `/cron list` — list crons\n" +
      "  `/cron edit <id> prompt | <new prompt>` — edit prompt\n" +
      "  `/cron edit <id> schedule | <new schedule>` — edit schedule\n" +
      "  `/cron delete <id>` — delete a cron\n" +
      "  `/cron pause <id>` — pause a cron\n" +
      "  `/cron resume <id>` — resume a cron\n\n" +
      "Example: `/cron every morning at 9am | Give me a brief summary of the day`",
      { parse_mode: "Markdown" }
    );
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const replyParams = { message_id: userMessageId };
    const isGroup = isGroupChat(ctx);

    // For new groups with no goal yet, set the first message as the goal
    if (isGroup && !getGroupGoal(chatId)) {
      const firstMessage = ctx.message.text;
      setGroupGoal(chatId, firstMessage.slice(0, 500));
      console.log(`[max] Set group goal for ${chatId}: ${firstMessage.slice(0, 80)}…`);
    }

    // Show "typing..." indicator
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTyping = () => {
      void ctx.replyWithChatAction("typing").catch(() => {});
      typingInterval = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    };
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };

    startTyping();

    sendToOrchestrator(
      ctx.message.text,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          void (async () => {
            const routeResult = getLastRouteResult();
            let indicatorSuffix = "";
            if (routeResult && !isGroup) {
              indicatorSuffix = routeResult.routerMode === "auto"
                ? `\n\n_⚡ auto · ${routeResult.model}_`
                : `\n\n_${routeResult.model}_`;
            }
            const formatted = toTelegramMarkdown(text) + indicatorSuffix;
            const chunks = chunkMessage(formatted);
            const fallbackText = routeResult && !isGroup
              ? text + (routeResult.routerMode === "auto"
                  ? `\n\n⚡ auto · ${routeResult.model}`
                  : `\n\n${routeResult.model}`)
              : text;
            const fallbackChunks = chunkMessage(fallbackText);
            const sendChunk = async (chunk: string, fallback: string, isFirst: boolean) => {
              const opts = isFirst
                ? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
                : { parse_mode: "MarkdownV2" as const };
              await ctx.reply(chunk, opts).catch(
                () => ctx.reply(fallback, isFirst ? { reply_parameters: replyParams } : {})
              );
            };
            try {
              for (let i = 0; i < chunks.length; i++) {
                await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i === 0);
              }
            } catch {
              try {
                for (let i = 0; i < fallbackChunks.length; i++) {
                  await ctx.reply(fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
                }
              } catch {
                // Nothing more we can do
              }
            }
          })();
        }
      }
    );
  });

  // Wire up the cron scheduler to send messages via this bot instance
  cronScheduler.setCronMessageSender(async (chatId: number, text: string) => {
    if (!bot) return;
    const formatted = toTelegramMarkdown(text);
    const chunks = chunkMessage(formatted);
    const fallbackChunks = chunkMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      try {
        await bot.api.sendMessage(chatId, chunks[i], { parse_mode: "MarkdownV2" });
      } catch {
        try {
          await bot.api.sendMessage(chatId, fallbackChunks[i] ?? chunks[i]);
        } catch { /* best effort */ }
      }
    }
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not created");
  console.log("[max] Telegram bot starting...");
  bot.start({
    onStart: () => console.log("[max] Telegram bot connected"),
    // Subscribe to chat member updates so we know when bot is removed from groups
    allowed_updates: ["message", "my_chat_member"],
  }).catch((err: any) => {
    if (err?.error_code === 401) {
      console.error("[max] ⚠️ Telegram bot token is invalid or expired. Run 'max setup' and re-enter your bot token from @BotFather.");
    } else if (err?.error_code === 409) {
      console.error("[max] ⚠️ Another bot instance is already running with this token. Stop the other instance first.");
    } else {
      console.error("[max] ❌ Telegram bot failed to start:", err?.message || err);
    }
  });
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
  }
}

/** Send an unsolicited message to the authorized user (for background task completions). */
export async function sendProactiveMessage(text: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  const formatted = toTelegramMarkdown(text);
  const chunks = chunkMessage(formatted);
  const fallbackChunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.api.sendMessage(config.authorizedUserId, chunks[i], { parse_mode: "MarkdownV2" });
    } catch {
      try {
        await bot.api.sendMessage(config.authorizedUserId, fallbackChunks[i] ?? chunks[i]);
      } catch {
        // Bot may not be connected yet
      }
    }
  }
}

/** Send a photo to the authorized user. Accepts a file path or URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  try {
    const { InputFile } = await import("grammy");
    const input = photo.startsWith("http") ? photo : new InputFile(photo);
    await bot.api.sendPhoto(config.authorizedUserId, input, {
      caption,
    });
  } catch (err) {
    console.error("[max] Failed to send photo:", err instanceof Error ? err.message : err);
    throw err;
  }
}
