import Database from "better-sqlite3";
import { DB_PATH, ensureMaxHome } from "../paths.js";

let db: Database.Database | undefined;
let logInsertCount = 0;

export function getDb(): Database.Database {
  if (!db) {
    ensureMaxHome();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS max_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        chat_id INTEGER,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        chat_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_config (
        chat_id INTEGER PRIMARY KEY,
        goal TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_allowlist (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS crons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        schedule_description TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        prompt TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate conversation_log: add chat_id column if missing
    try {
      db.exec(`ALTER TABLE conversation_log ADD COLUMN chat_id INTEGER`);
    } catch { /* already exists */ }

    // Migrate memories: add chat_id column if missing
    try {
      db.exec(`ALTER TABLE memories ADD COLUMN chat_id INTEGER`);
    } catch { /* already exists */ }

    // Migrate group_config: add model column if missing
    try {
      db.exec(`ALTER TABLE group_config ADD COLUMN model TEXT`);
    } catch { /* already exists */ }

    // Migrate: if conversation_log had a stricter CHECK on role, recreate it
    try {
      db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`).run();
      db.prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`).run();
    } catch {
      db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
      db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          chat_id INTEGER,
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`);
      db.exec(`DROP TABLE conversation_log_old`);
    }
    // Per-namespace pruning: keep the 200 most recent rows per chat_id
    db.exec(`
      DELETE FROM conversation_log WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS rn
          FROM conversation_log
        ) WHERE rn <= 200
      )
    `);
  }
  return db;
}

export function getState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM max_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO max_state (key, value) VALUES (?, ?)`).run(key, value);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM max_state WHERE key = ?`).run(key);
}

/** Log a conversation turn (user, assistant, or system). chatId=undefined means DM. */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string, chatId?: number): void {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_log (role, content, source, chat_id) VALUES (?, ?, ?, ?)`).run(role, content, source, chatId ?? null);
  logInsertCount++;
  if (logInsertCount % 50 === 0) {
    // Prune per-namespace: keep last 200 entries per chat context
    db.prepare(`
      DELETE FROM conversation_log WHERE id NOT IN (
        SELECT id FROM conversation_log WHERE chat_id IS ?
        ORDER BY id DESC LIMIT 200
      ) AND chat_id IS ?
    `).run(chatId ?? null, chatId ?? null);
  }
}

/** Get recent conversation history for a specific chat context. */
export function getRecentConversation(limit = 20, chatId?: number): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT role, content, source, ts FROM conversation_log WHERE chat_id IS ? ORDER BY id DESC LIMIT ?`
  ).all(chatId ?? null, limit) as { role: string; content: string; source: string; ts: string }[];

  if (rows.length === 0) return "";
  rows.reverse();

  return rows.map((r) => {
    const tag = r.role === "user" ? `[${r.source}] User`
      : r.role === "system" ? `[${r.source}] System`
      : "Max";
    const content = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
    return `${tag}: ${content}`;
  }).join("\n\n");
}

/** Add a memory to long-term storage. chatId=undefined means DM/global. */
export function addMemory(
  category: "preference" | "fact" | "project" | "person" | "routine",
  content: string,
  source: "user" | "auto" = "user",
  chatId?: number
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO memories (category, content, source, chat_id) VALUES (?, ?, ?, ?)`
  ).run(category, content, source, chatId ?? null);
  return result.lastInsertRowid as number;
}

/** Search memories for a specific chat context. */
export function searchMemories(
  keyword?: string,
  category?: string,
  limit = 20,
  chatId?: number
): { id: number; category: string; content: string; source: string; created_at: string }[] {
  const db = getDb();
  const conditions: string[] = ["chat_id IS ?"];
  const params: (string | number | null)[] = [chatId ?? null];

  if (keyword) {
    conditions.push(`content LIKE ?`);
    params.push(`%${keyword}%`);
  }
  if (category) {
    conditions.push(`category = ?`);
    params.push(category);
  }

  params.push(limit);

  const rows = db.prepare(
    `SELECT id, category, content, source, created_at FROM memories WHERE ${conditions.join(" AND ")} ORDER BY last_accessed DESC LIMIT ?`
  ).all(...params) as { id: number; category: string; content: string; source: string; created_at: string }[];

  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...rows.map((r) => r.id));
  }

  return rows;
}

/** Remove a memory by ID, scoped to the given chat context. */
export function removeMemory(id: number, chatId?: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM memories WHERE id = ? AND chat_id IS ?`).run(id, chatId ?? null);
  return result.changes > 0;
}

/** Get a compact summary of all memories for a specific chat context. */
export function getMemorySummary(chatId?: number): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, category, content FROM memories WHERE chat_id IS ? ORDER BY category, last_accessed DESC`
  ).all(chatId ?? null) as { id: number; category: string; content: string }[];

  if (rows.length === 0) return "";

  const grouped: Record<string, { id: number; content: string }[]> = {};
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push({ id: r.id, content: r.content });
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const lines = items.map((i) => `  - [#${i.id}] ${i.content}`).join("\n");
    return `**${cat}**:\n${lines}`;
  });

  return sections.join("\n");
}

// ── Group management ──────────────────────────────────────────────────────────

/** Set the goal for a group chat (first message). Preserves existing model setting. */
export function setGroupGoal(chatId: number, goal: string): void {
  const db = getDb();
  // Use INSERT with ON CONFLICT UPDATE to preserve the model column
  db.prepare(`
    INSERT INTO group_config (chat_id, goal) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET goal = excluded.goal
  `).run(chatId, goal);
}

/** Get the goal for a group chat. */
export function getGroupGoal(chatId: number): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT goal FROM group_config WHERE chat_id = ?`).get(chatId) as { goal: string } | undefined;
  return row?.goal;
}

/** Set the model override for a group chat. Pass null to clear (revert to global). */
export function setGroupModel(chatId: number, model: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO group_config (chat_id, goal, model) VALUES (?, '', ?)
    ON CONFLICT(chat_id) DO UPDATE SET model = excluded.model
  `).run(chatId, model);
}

/** Get the model override for a group chat, or undefined to use global default. */
export function getGroupModel(chatId: number): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT model FROM group_config WHERE chat_id = ?`).get(chatId) as { model: string | null } | undefined;
  return row?.model ?? undefined;
}

/** Check if a user is allowed to interact with the bot in a group. */
export function isGroupAllowed(chatId: number, userId: number, authorizedUserId: number): boolean {
  if (userId === authorizedUserId) return true;
  const db = getDb();
  const row = db.prepare(`SELECT 1 FROM group_allowlist WHERE chat_id = ? AND user_id = ?`).get(chatId, userId);
  return row !== undefined;
}

/** Add a user to a group's allowlist. */
export function addGroupAllowlist(chatId: number, userId: number, username?: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO group_allowlist (chat_id, user_id, username) VALUES (?, ?, ?)`).run(chatId, userId, username ?? null);
}

/** Remove a user from a group's allowlist. */
export function removeGroupAllowlist(chatId: number, userId: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM group_allowlist WHERE chat_id = ? AND user_id = ?`).run(chatId, userId);
  return result.changes > 0;
}

/** List all allowlisted users for a group. */
export function getGroupAllowlist(chatId: number): { userId: number; username: string | null }[] {
  const db = getDb();
  const rows = db.prepare(`SELECT user_id, username FROM group_allowlist WHERE chat_id = ?`).all(chatId) as { user_id: number; username: string | null }[];
  return rows.map((r) => ({ userId: r.user_id, username: r.username }));
}

// ── Cron management ───────────────────────────────────────────────────────────

export interface CronRow {
  id: number;
  chat_id: number;
  schedule_description: string;
  cron_expression: string;
  prompt: string;
  paused: number;
  created_at: string;
}

/** Create a new cron job and return its ID. */
export function createCron(chatId: number, scheduleDescription: string, cronExpression: string, prompt: string): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO crons (chat_id, schedule_description, cron_expression, prompt) VALUES (?, ?, ?, ?)`
  ).run(chatId, scheduleDescription, cronExpression, prompt);
  return result.lastInsertRowid as number;
}

/** Get all crons for a specific chat. */
export function getCrons(chatId: number): CronRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM crons WHERE chat_id = ? ORDER BY id`).all(chatId) as CronRow[];
}

/** Get all non-paused crons (for startup loading). */
export function getAllActiveCrons(): CronRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM crons WHERE paused = 0`).all() as CronRow[];
}

/** Delete a cron by ID, scoped to chatId for safety. Returns true if deleted. */
export function deleteCron(id: number, chatId: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM crons WHERE id = ? AND chat_id = ?`).run(id, chatId);
  return result.changes > 0;
}

/** Set paused state for a cron, scoped to chatId for safety. Returns true if updated. */
export function setCronPaused(id: number, chatId: number, paused: boolean): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE crons SET paused = ? WHERE id = ? AND chat_id = ?`).run(paused ? 1 : 0, id, chatId);
  return result.changes > 0;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

