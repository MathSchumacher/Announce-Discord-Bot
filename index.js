/**
 * Announce Bot — Version C (Auto-Resume after rebuild)
 *
 * Recursos:
 * - 3 workers paralelos (producer-consumer)
 * - Delay adaptativo + rate limit aware
 * - Persistência automática em progress.json
 * - AUTO-RESUME após QUEDA, KILL, REDEPLOY, BUILD NOVO
 * - Sem confirmação no Discord: retomada totalmente automática
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ========== CONFIG ==========
const WORKERS = 3;
const PAGE_LIMIT = 1000;
const RETRIES = 1;

const GLOBAL_MIN = 350;
const GLOBAL_MAX = 5000;
const GLOBAL_INITIAL = 500;

const WORKER_MIN = 350;
const WORKER_MAX = 5000;
const WORKER_INITIAL = 450;

const SAVE_EVERY = 30;
const PROGRESS_FILE = path.resolve(__dirname, "progress.json");
const TEMP_FILE = path.resolve(__dirname, "progress.tmp.json");
// =============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

let queue = [];
let producerDone = false;

let stats = { queued: 0, sent: 0, failed: 0, skipped: 0 };
let blocked = new Set();

let saveCounter = 0;

// delays
let globalDelay = GLOBAL_INITIAL;
let lastSendTs = 0;
let limiterLocked = false;
let workerDelay = Array.from({ length: WORKERS }, () => WORKER_INITIAL);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function atomicSave(file, data) {
  try {
    fs.writeFileSync(TEMP_FILE, JSON.stringify(data, null, 2));
    fs.renameSync(TEMP_FILE, file);
  } catch (err) { console.warn("Save error:", err); }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); }
  catch { return null; }
}

function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); }
  catch {}
}

async function acquireSlot() {
  while (true) {
    const elapsed = Date.now() - lastSendTs;
    if (!limiterLocked && elapsed >= globalDelay) {
      limiterLocked = true;
      return;
    }
    await wait(20);
  }
}

function releaseSlot() {
  limiterLocked = false;
  lastSendTs = Date.now();
}

function onSuccess(workerIdx) {
  workerDelay[workerIdx] = Math.max(WORKER_MIN, workerDelay[workerIdx] * 0.95);
  globalDelay = Math.max(GLOBAL_MIN, globalDelay * 0.97);
}

function onRate(workerIdx) {
  workerDelay[workerIdx] = Math.min(WORKER_MAX, workerDelay[workerIdx] * 1.5);
  globalDelay = Math.min(GLOBAL_MAX, globalDelay * 1.5);
}

function parseSelectors(text) {
  const ignore = new Set();
  const only = new Set();
  const regex = /([+-])\{(\d{5,30})\}/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const type = m[1];
    const id = m[2];
    if (type === "-") ignore.add(id);
    else only.add(id);
  }
  const msg = text.replace(regex, "").trim();
  return { msg, ignore, only };
}

async function sendDM(member, payload, worker) {
  if (!member?.user) return { ok: false };

  const id = member.user.id;
  if (blocked.has(id)) return { ok: false, reason: "blocked" };

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      await acquireSlot();
      await member.send(payload);
      releaseSlot();

      onSuccess(worker);
      return { ok: true };
    } catch (err) {
      releaseSlot();

      const code = err.status ?? err.code ?? err.statusCode ?? err.rawError?.status;

      if (code === 50007 || code === 403 || code === 50013) {
        blocked.add(id);
        stats.skipped++;
        return { ok: false, reason: "dm_closed" };
      }

      if (code === 429) {
        console.warn("429 detected → Backoff");
        onRate(worker);
        await wait(globalDelay);
        continue;
      }

      await wait(400);
    }
  }

  stats.failed++;
  return { ok: false, reason: "failed" };
}

async function resumeQueue(guild, progress, text, attachments) {
  console.log("Restaurando fila a partir do progress.json…");

  for (const id of progress.queued) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) continue;

    const payload = {};
    if (text) payload.content = text;
    if (attachments.length) payload.files = attachments;

    queue.push({ id, member, payload });
    stats.queued++;
  }

  console.log("Fila restaurada:", stats.queued, "membros.");
  producerDone = true;
}

async function produceQueue(guild, text, attachments, ignore, only, mode) {
  let after;

  while (true) {
    const batch = await guild.members.list({ limit: PAGE_LIMIT, after });
    if (batch.size === 0) break;

    for (const member of batch.values()) {
      if (member.user.bot) continue;

      const id = member.user.id;

      if (mode === "announce" && ignore.has(id)) continue;
      if (mode === "for" && !only.has(id)) continue;

      const payload = {};
      if (text) payload.content = text;
      if (attachments.length) payload.files = attachments;

      queue.push({ id, member, payload });
      stats.queued++;
    }

    after = batch.last().user.id;
    await wait(120);
  }

  producerDone = true;
}

function saveProgress() {
  const snapshot = {
    queued: queue.map(x => x.id),
    stats,
    time: Date.now(),
  };
  atomicSave(PROGRESS_FILE, snapshot);
}

async function workerLoop(idx) {
  console.log("Worker", idx, "iniciado");

  while (true) {
    const job = queue.shift();

    if (!job) {
      if (producerDone) return;
      await wait(80);
      continue;
    }

    if (blocked.has(job.id)) {
      stats.skipped++;
      continue;
    }

    await wait(workerDelay[idx]);

    const result = await sendDM(job.member, job.payload, idx);
    if (result.ok) stats.sent++;

    if (++saveCounter >= SAVE_EVERY) {
      saveProgress();
      saveCounter = 0;
    }
  }
}

client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith("!announce") &&
      !msg.content.startsWith("!announcefor")) return;
  if (msg.author.bot) return;

  const mode = msg.content.startsWith("!announcefor") ? "for" : "announce";
  const raw = msg.content.replace("!announcefor", "").replace("!announce", "").trim();
  const { msg: text, ignore, only } = parseSelectors(raw);

  const attachments = [];
  for (const a of msg.attachments.values()) attachments.push(a.url);

  const guild = msg.guild;
  if (!guild) return msg.reply("Use o comando dentro do servidor.");

  // RESET DE EXECUÇÃO
  queue = [];
  producerDone = false;
  stats = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  blocked = new Set();
  globalDelay = GLOBAL_INITIAL;
  workerDelay = Array.from({ length: WORKERS }, () => WORKER_INITIAL);
  saveCounter = 0;

  msg.reply("📢 Enfileirando membros…");

  const saved = loadProgress();

  if (saved && saved.queued.length > 0) {
    msg.reply("🔁 **Retomando automaticamente** envio interrompido anteriormente…");

    await resumeQueue(guild, saved, text, attachments);
  } else {
    clearProgress();
    msg.reply("🆕 Iniciando novo envio…");
    await produceQueue(guild, text, attachments, ignore, only, mode);
  }

  const workers = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(workerLoop(i));
  }

  await Promise.all(workers);

  saveProgress();
  clearProgress();

  msg.reply(`✅ Finalizado!\nEnviadas: ${stats.sent}\nFalhas: ${stats.failed}\nDM Fechada: ${stats.skipped}`);
});

client.on("ready", () => {
  console.log("Bot online:", client.user.tag);
});

client.login(process.env.DISCORD_TOKEN);
