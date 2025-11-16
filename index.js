/**
 * Announce Bot - Version B (3 workers, safe & fast for Railway Free)
 *
 * - 3 internal workers
 * - Persistent progress (progress.json) and auto-resume
 * - Paginação correta via guild.members.fetch({limit, after})
 * - Queue holds member IDs (low memory)
 * - Adaptive delay per worker + global limiter
 * - Support for -{id} and +{id} selectors
 *
 * Keep .env with DISCORD_TOKEN (do NOT commit .env nor progress.json)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ---------------- CONFIG ----------------
const WORKER_COUNT = 3;      // chosen by you
const PAGE_LIMIT = 1000;
const RETRY_LIMIT = 1;       // retries on transient errors
const SAVE_EVERY = 25;       // persist every N sends
const PROGRESS_FILE = path.resolve(__dirname, "progress.json");

// Adaptive timings (ms)
const GLOBAL_INITIAL = 500;  // global initial spacing
const GLOBAL_MIN = 350;
const GLOBAL_MAX = 5000;

const WORKER_INITIAL = 500;  // per-worker initial wait before each send
const WORKER_MIN = 350;
const WORKER_MAX = 5000;

// Idle waits to avoid busy loops
const IDLE_WAIT_SHORT = 100;
const IDLE_WAIT_LONG = 400;
// ----------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ---------- STATE ----------
let queue = []; // array of member IDs to send to
let producingDone = false;
let stats = { queued: 0, sent: 0, failed: 0, skippedBlocked: 0 };
let blockedCache = new Set(); // users with DM closed in this run

let globalDelay = GLOBAL_INITIAL;
let lastSendTs = 0;
let limiterLocked = false;

const workerDelays = Array.from({ length: WORKER_COUNT }, () => WORKER_INITIAL);

let sinceLastSave = 0;
// ---------------------------

// Utilities
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function atomicSave(file, data) {
  try {
    fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(file + ".tmp", file);
  } catch (err) {
    console.warn("atomicSave error:", err);
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch (err) {
    console.warn("Failed reading progress.json:", err);
    return null;
  }
}

function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); } catch {}
}

// ---------- Limiter (global slot) ----------
async function acquireSendSlot() {
  // Ensure spacing between sends and single-sender at a time
  while (true) {
    const now = Date.now();
    const elapsed = now - lastSendTs;
    if (!limiterLocked && elapsed >= globalDelay) {
      limiterLocked = true;
      return;
    }
    await wait(25); // short sleep to reduce busy CPU
  }
}

function releaseSendSlot() {
  lastSendTs = Date.now();
  limiterLocked = false;
}

function onGlobalSuccess() {
  globalDelay = Math.max(GLOBAL_MIN, Math.round(globalDelay * 0.97));
}

function onGlobalRateLimit(retryAfterMs = null) {
  if (retryAfterMs && typeof retryAfterMs === "number") {
    // if API said retryAfter, respect it strongly
    globalDelay = Math.max(globalDelay, Math.min(GLOBAL_MAX, Math.round(retryAfterMs)));
  } else {
    globalDelay = Math.min(GLOBAL_MAX, Math.round(globalDelay * 1.5));
  }
}

// Worker-level adjustments
function onWorkerSuccess(idx) {
  workerDelays[idx] = Math.max(WORKER_MIN, Math.round(workerDelays[idx] * 0.95));
}
function onWorkerRateLimit(idx) {
  workerDelays[idx] = Math.min(WORKER_MAX, Math.round(workerDelays[idx] * 1.5));
}
// -------------------------------------------

// Extract status / retry info from error
function extractErrorInfo(err) {
  if (!err) return {};
  const status = err?.status ?? err?.statusCode ?? err?.code ?? null;
  // discord.js sometimes provides rawError with retry_after in seconds
  const retryAfterSeconds = err?.rawError?.retry_after ?? err?.retry_after ?? null;
  const retryAfterMs = retryAfterSeconds ? Math.round(retryAfterSeconds * 1000) : null;
  return { status, retryAfterMs };
}

// Try send DM: fetch member then send
async function trySendToId(guild, userId, payload, workerIdx) {
  if (blockedCache.has(userId)) {
    stats.skippedBlocked++;
    return { ok: false, reason: "blocked_cached" };
  }

  // fetch member object (may fail if user left or is not in guild)
  let member = null;
  try {
    member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      // member not in guild or cannot be fetched: skip as failed
      stats.failed++;
      return { ok: false, reason: "no_member" };
    }
  } catch (err) {
    stats.failed++;
    return { ok: false, reason: "fetch_error" };
  }

  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await acquireSendSlot();
      await member.send(payload);
      releaseSendSlot();

      // successes
      stats.sent++;
      onGlobalSuccess();
      onWorkerSuccess(workerIdx);
      return { ok: true };
    } catch (err) {
      // ensure limiter cleared
      if (limiterLocked) {
        limiterLocked = false;
        lastSendTs = Date.now();
      }

      const { status, retryAfterMs } = extractErrorInfo(err);

      // DM closed or cannot send to user
      if (status === 50007 || status === 403 || status === 50013) {
        blockedCache.add(userId);
        stats.skippedBlocked++;
        return { ok: false, reason: "dm_closed" };
      }

      // Rate limit
      if (status === 429) {
        console.warn(`Worker ${workerIdx}: 429 rate limit for ${userId}. retryAfterMs=${retryAfterMs}`);
        onGlobalRateLimit(retryAfterMs);
        onWorkerRateLimit(workerIdx);
        // Wait advised time or globalDelay
        await wait(retryAfterMs || globalDelay);
        continue; // retry
      }

      // Other transient errors -> small backoff
      console.warn(`Worker ${workerIdx}: error sending to ${userId} (attempt ${attempt + 1}):`, err?.message ?? err);
      await wait(800 * (attempt + 1));
    }
  }

  // final fail
  stats.failed++;
  return { ok: false, reason: "failed_after_retries" };
}

// ---------- Producer: pages members and fills queue ----------
async function produceQueue(guild, cleanedText, attachments, ignoreSet, onlySet, mode, resumeObj) {
  // If resume exists, rebuild queue from saved IDs
  if (resumeObj && Array.isArray(resumeObj.queued) && resumeObj.queued.length > 0) {
    console.log("Resuming from saved progress:", resumeObj.queued.length, "items");
    queue = resumeObj.queued.slice(); // copy IDs
    stats.queued = queue.length;
    producingDone = true;
    return;
  }

  console.log("Producer: starting pagination...");
  let after = undefined;
  while (true) {
    const batch = await guild.members.fetch({ limit: PAGE_LIMIT, after }).catch(err => {
      console.warn("Producer: guild.members.fetch error:", err?.message ?? err);
      return null;
    });
    if (!batch || batch.size === 0) break;

    for (const member of batch.values()) {
      if (!member || member.user?.bot) continue;
      const uid = member.user.id;

      if (mode === "announce" && ignoreSet.has(uid)) continue;
      if (mode === "for" && !onlySet.has(uid)) continue;

      queue.push(uid);
      stats.queued++;
      // yield occasionally to reduce pressure (reduce CPU)
      if (stats.queued % 200 === 0) await wait(30);
    }

    after = batch.last()?.id;
    console.log(`Producer: loaded page, queued=${stats.queued}`);
    await wait(150);
  }

  producingDone = true;
  console.log("Producer: done. total queued:", stats.queued);
}

// ---------- Worker loop ----------
async function workerLoop(idx, guild, payload) {
  console.log(`Worker ${idx} started (init delay ${workerDelays[idx]}ms)`);
  while (true) {
    const userId = queue.shift();

    if (!userId) {
      if (producingDone) {
        console.log(`Worker ${idx} finishing: queue empty & producer done`);
        return;
      }
      // no item right now
      await wait(IDLE_WAIT_SHORT);
      continue;
    }

    // local adaptive wait to avoid bursts
    await wait(workerDelays[idx]);

    const res = await trySendToId(guild, userId, payload, idx);
    // adjust per-worker behavior already inside trySendToId

    // persist occasionally
    sinceLastSave++;
    if (sinceLastSave >= SAVE_EVERY) {
      persistProgress(guild?.id);
      sinceLastSave = 0;
    }

    // when queue huge, give tiny breathing room to CPU
    if (queue.length > 2000) await wait(100);
  }
}

// ---------- Persistence ----------
function persistProgress(guildId = null) {
  try {
    const snapshot = {
      queued: queue.slice(0), // remaining ids
      stats,
      guildId,
      timestamp: Date.now()
    };
    atomicSave(PROGRESS_FILE, snapshot);
    // console.log("Progress saved (queued:", snapshot.queued.length, ")");
  } catch (err) {
    console.warn("persistProgress failed:", err);
  }
}

function loadSavedProgress() {
  return loadProgress();
}

// ---------- parse selectors ----------
function parseUserSelectors(text) {
  const ignore = new Set();
  const only = new Set();
  const regex = /([+-])\{(\d{5,30})\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const sign = match[1];
    const id = match[2];
    if (sign === "-") ignore.add(id);
    if (sign === "+") only.add(id);
  }
  const cleaned = text.replace(regex, "").trim();
  return { cleaned, ignore, only };
}

// ---------- MAIN handler ----------
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!announce") && !message.content.startsWith("!announcefor")) return;
  if (message.author.bot) return;

  const mode = message.content.startsWith("!announcefor") ? "for" : "announce";
  const rawText = message.content.replace("!announcefor", "").replace("!announce", "").trim();
  const { cleaned, ignore, only } = parseUserSelectors(rawText);
  const attachments = [...message.attachments.values()].map(a => a.url);

  if (!cleaned && attachments.length === 0) {
    return message.reply("Use: `!announce texto -{id}` ou `!announcefor texto +{id}`");
  }

  const guild = message.guild;
  if (!guild) return message.reply("Comando só pode ser usado dentro de um servidor.");

  // reset state
  queue = [];
  producingDone = false;
  stats = { queued: 0, sent: 0, failed: 0, skippedBlocked: 0 };
  blockedCache = new Set();
  globalDelay = GLOBAL_INITIAL;
  for (let i=0;i<WORKER_COUNT;i++) workerDelays[i] = WORKER_INITIAL;
  sinceLastSave = 0;
  clearProgress();

  await message.reply("📢 Iniciando envio (modo B - 3 workers)...");

  // Build payload once
  const payload = {};
  if (cleaned) payload.content = cleaned;
  if (attachments.length) payload.files = attachments.slice(0);

  // Check for saved progress to auto-resume
  const saved = loadSavedProgress();
  let resumeObj = null;
  if (saved && Array.isArray(saved.queued) && saved.queued.length > 0) {
    // If the saved guildId exists and matches current guild or is null, resume
    if (!saved.guildId || saved.guildId === guild.id) {
      resumeObj = saved;
      console.log("Found saved progress - auto-resume will restore queue length:", saved.queued.length);
    } else {
      // different guild saved — ignore
      console.log("Saved progress belongs to different guild - ignoring.");
      clearProgress();
    }
  }

  // Start producer (either resume or fresh)
  produceQueue(guild, cleaned, attachments, ignore, only, mode, resumeObj).catch(err => {
    console.error("Producer error:", err);
    producingDone = true;
  });

  // start workers
  const workerPromises = [];
  for (let i=0;i<WORKER_COUNT;i++) {
    workerPromises.push(workerLoop(i, guild, payload));
  }

  // Wait for workers to finish
  await Promise.all(workerPromises);

  // final persist and cleanup
  persistProgress(guild.id);
  // remove file on complete to indicate finished
  try { clearProgress(); } catch {}
  await message.reply(`✅ Finalizado!\nEnviadas: ${stats.sent}\nFalhas: ${stats.failed}\nDM fechada/skips: ${stats.skippedBlocked}`);
  console.log("Run finished:", stats);
});

// ---------- ready & login ----------
client.on("ready", () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Login error:", err);
  process.exit(1);
});
