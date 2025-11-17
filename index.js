/**
 * ==============================
 *     VERSION B PRIME (SAFE)
 *  Ultra Secure + Fast + Resume
 * 3 Internal Workers - Railway Safe
 * ==============================
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ===== CONFIG =====
const WORKERS = 3;
const DELAY_MIN = 350;
const DELAY_MAX = 5000;
const DELAY_START = 500;
const RETRY_LIMIT = 2;
const PAGE_LIMIT = 1000;

const JOB_FILE = path.resolve(__dirname, "job.json");
// ===================

let lockActive = false;               // prevents multiple commands
let jobId = null;                     // identifies current job
let queue = [];                       // pending user IDs
let completed = new Set();            // finished user IDs
let stats = { sent: 0, failed: 0, dmClosed: 0, total: 0 };

// Adaptive delays
let globalDelay = DELAY_START;
const workerDelay = Array.from({ length: WORKERS }, () => DELAY_START);

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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== JOB SAVE / LOAD ==========
function saveJob() {
  fs.writeFileSync(JOB_FILE, JSON.stringify({
    jobId,
    queue,
    completed: [...completed],
    stats
  }, null, 2));
}

function loadJob() {
  if (!fs.existsSync(JOB_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
  } catch {
    return null;
  }
}

function clearJob() {
  try { fs.unlinkSync(JOB_FILE); } catch {}
}

// =====================================
// ======== MESSAGE SENDER =============
// =====================================
async function trySend(guild, uid, payload, workerIdx) {
  let member;
  
  try {
    member = await guild.members.fetch(uid);
  } catch {
    stats.failed++;
    return false;
  }

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await wait(workerDelay[workerIdx]);
      await member.send(payload);

      stats.sent++;
      completed.add(uid);
      workerDelay[workerIdx] = Math.max(DELAY_MIN, workerDelay[workerIdx] * 0.92);
      globalDelay = Math.max(DELAY_MIN, globalDelay * 0.94);
      return true;

    } catch (err) {
      const code = err?.status ?? err?.code ?? null;

      if (code === 50007 || code === 403) {
        stats.dmClosed++;
        completed.add(uid);
        return false;
      }

      if (code === 429) {
        const retry = (err?.rawError?.retry_after || 1) * 1000;
        globalDelay = Math.min(DELAY_MAX, retry);
        workerDelay[workerIdx] = Math.min(DELAY_MAX, retry);
        await wait(retry);
        continue;
      }

      await wait(800 * attempt);
    }
  }

  stats.failed++;
  completed.add(uid);
  return false;
}

// =====================================
// ========== WORKER ====================
// =====================================
async function workerLoop(workerIdx, guild, payload) {
  while (true) {
    if (queue.length === 0) {
      await wait(150);
      continue;
    }

    const uid = queue.shift();

    if (completed.has(uid)) {
      continue;
    }

    await trySend(guild, uid, payload, workerIdx);
    saveJob();

    if (completed.size >= stats.total) {
      return;
    }
  }
}

// =====================================
// =========== PRODUCER ================
// =====================================
async function producer(guild, mode, ignore, only) {
  queue = [];
  let after;

  while (true) {
    const members = await guild.members.list({ limit: PAGE_LIMIT, after });
    if (members.size === 0) break;

    for (const m of members.values()) {
      if (m.user.bot) continue;
      const uid = m.user.id;

      if (mode === "announce" && ignore.has(uid)) continue;
      if (mode === "for"      && !only.has(uid))   continue;

      queue.push(uid);
    }

    after = members.last().id;
    await wait(50);
  }

  stats.total = queue.length;
}

// =====================================
// ========== SELECTORS ================
// =====================================
function parseSelectors(text) {
  const ignore = new Set();
  const only = new Set();
  const regex = /([+-])\{(\d{5,30})\}/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const type = match[1];
    const id = match[2];

    if (type === "-") ignore.add(id);
    if (type === "+") only.add(id);
  }

  return { cleaned: text.replace(regex, "").trim(), ignore, only };
}

// =====================================
// ========== COMMAND HANDLER ==========
// =====================================
client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith("!announce")) return;
  if (msg.author.bot) return;

  if (lockActive) {
    return msg.reply("❌ Já existe um envio em andamento. Aguarde terminar.");
  }

  lockActive = true;

  const isFor = msg.content.startsWith("!announcefor");
  const mode = isFor ? "for" : "announce";

  const { cleaned, ignore, only } = parseSelectors(
    msg.content.replace("!announcefor", "").replace("!announce", "").trim()
  );

  const attachments = [...msg.attachments.values()].map(a => a.url);

  if (!cleaned && attachments.length === 0) {
    lockActive = false;
    return msg.reply("❌ Use `!announce texto -{id}` ou `!announcefor texto +{id}`");
  }

  const guild = msg.guild;

  // create payload
  const payload = {};
  if (cleaned) payload.content = cleaned;
  if (attachments.length) payload.files = attachments;

  // new job id
  jobId = `job_${Date.now()}`;
  clearJob();
  saveJob();

  await msg.reply("📢 Preparando envio…");

  await producer(guild, mode, ignore, only);

  if (stats.total === 0) {
    lockActive = false;
    return msg.reply("⚠ Nenhum membro correspondente aos filtros.");
  }

  await msg.reply(`🔄 Iniciando envio (${stats.total} membros)…`);

  const workers = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(workerLoop(i, guild, payload));
  }

  await Promise.all(workers);

  await msg.reply(
    `✅ Finalizado!\nEnviadas: ${stats.sent}\nDM fechada: ${stats.dmClosed}\nFalhas: ${stats.failed}`
  );

  clearJob();
  lockActive = false;
});

// =====================================
// ============== READY ================
// =====================================
client.on("ready", () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
