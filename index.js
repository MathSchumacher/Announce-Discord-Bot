require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIGS =====
const WORKERS = 1; // 1 worker seguro para host free
const DELAY_BASE = 1200; // 1.2s entre envios (ajuste se quiser)
const RETRY_LIMIT = 2;
const STATE_FILE = path.resolve(__dirname, "state.json");
const SENT_FILE = path.resolve(__dirname, "sent.txt");
const PROGRESS_UPDATE_INTERVAL = 5000;
// ===================

// === State persistence ===
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    return Object.assign({
      active: false,
      guildId: null,
      text: "",
      attachments: [],
      ignore: [],
      only: [],
      queue: [],
      stats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null, // { channelId, messageId }
      mode: "announce"
    }, s);
  } catch {
    return {
      active: false,
      guildId: null,
      text: "",
      attachments: [],
      ignore: [],
      only: [],
      queue: [],
      stats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null,
      mode: "announce"
    };
  }
}

function saveState(s) {
  try {
    const copy = {
      active: !!s.active,
      guildId: s.guildId || null,
      text: s.text || "",
      attachments: Array.isArray(s.attachments) ? s.attachments : [],
      ignore: Array.isArray(s.ignore) ? s.ignore : [],
      only: Array.isArray(s.only) ? s.only : [],
      queue: Array.isArray(s.queue) ? s.queue : [],
      stats: s.stats || { success: 0, fail: 0, closed: 0 },
      progressMessageRef: (s.progressMessageRef && s.progressMessageRef.channelId && s.progressMessageRef.messageId) ? s.progressMessageRef : null,
      mode: s.mode || "announce"
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));
  } catch (e) {
    console.error("Erro ao salvar state:", e);
  }
}

let state = loadState();

// === Discord client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// runtime refs (não persistidos)
let progressMessageRuntime = null;
let progressUpdaterHandle = null;
let workerRunning = false;

// === utils ===
const wait = ms => new Promise(res => setTimeout(res, ms));

function parseSelectors(text) {
  const ignore = new Set();
  const only = new Set();
  const regex = /([+-])\{(\d{5,30})\}/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m[1] === '-') ignore.add(m[2]);
    if (m[1] === '+') only.add(m[2]);
  }
  return { cleaned: text.replace(regex, "").trim(), ignore, only };
}

async function sendDMToUser(userOrMember, payload) {
  // userOrMember may be a User or GuildMember; both have .send
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await (userOrMember.send ? userOrMember.send(payload) : userOrMember.send(payload));
      return true;
    } catch (err) {
      if (err?.code === 50007) return "closed"; // cannot send messages to this user
      // rate limit handling if available
      const retryAfter = err?.retry_after || err?.retryAfter || null;
      if (retryAfter) {
        const ms = Number(retryAfter) + 300;
        await wait(ms);
        continue;
      }
      if (err?.status === 429 || err?.statusCode === 429) {
        const ms = 2000 * attempt;
        await wait(ms);
        continue;
      }
      // backoff
      await wait(1200 * attempt);
    }
  }
  return false;
}

// === Progress embed utils ===
async function updateProgressEmbed() {
  if (!state.progressMessageRef) return;
  try {
    const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
    if (!msg) return;
    const embed = new EmbedBuilder()
      .setTitle("📨 Envio em progresso")
      .setColor("#00AEEF")
      .addFields(
        { name: "Enviadas", value: `${state.stats.success}`, inline: true },
        { name: "Falhas", value: `${state.stats.fail}`, inline: true },
        { name: "DM Fechada", value: `${state.stats.closed}`, inline: true },
        { name: "Restando", value: `${state.queue.length}`, inline: true }
      )
      .setTimestamp();
    await msg.edit({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    // ignore
  }
}

function startProgressUpdater() {
  if (progressUpdaterHandle) return;
  progressUpdaterHandle = setInterval(() => {
    if (!state.active) return;
    updateProgressEmbed();
  }, PROGRESS_UPDATE_INTERVAL);
}

function stopProgressUpdater() {
  if (progressUpdaterHandle) {
    clearInterval(progressUpdaterHandle);
    progressUpdaterHandle = null;
  }
}

// === Worker (single) ===
async function workerLoop() {
  console.log("Worker iniciado.");
  try {
    while (state.active && state.queue && state.queue.length > 0) {
      const userId = state.queue.shift();
      saveState(state);

      // fetch user (less heavy than guild.members.fetch every time)
      let user = null;
      try {
        user = await client.users.fetch(userId).catch(() => null);
      } catch { user = null; }
      if (!user || user.bot) continue;

      // Attempt sending: images first, then text. Only when both succeed (or the only present part succeeds) we write to sent.txt
      let imageOk = true;
      let textOk = true;

      // 1) images
      if (state.attachments && state.attachments.length > 0) {
        const imgPayload = { files: state.attachments };
        const r = await sendDMToUser(user, imgPayload);
        if (r === "closed") {
          state.stats.closed++;
          saveState(state);
          await wait(DELAY_BASE);
          continue; // do not try text if images can't be sent due to closed DM
        } else if (r !== true) {
          imageOk = false;
          state.stats.fail++;
          saveState(state);
          await wait(DELAY_BASE);
          continue; // on image fail treat as fail and skip text (do not add to sent.txt)
        }
      }

      // 2) text
      if (state.text) {
        const textPayload = { content: state.text };
        const r2 = await sendDMToUser(user, textPayload);
        if (r2 === "closed") {
          state.stats.closed++;
          textOk = false;
        } else if (r2 !== true) {
          textOk = false;
          state.stats.fail++;
        }
      }

      // Determine success: if there were attachments they must be ok; if text present it must be ok.
      const wasSuccess = ( (state.attachments.length === 0 || imageOk) && ( !state.text || textOk ) );

      if (wasSuccess) {
        state.stats.success++;
        // append to sent.txt in the exact required format -{${userId}}
        try {
          fs.appendFileSync(SENT_FILE, `-{${userId}}\n`);
        } catch (e) {
          console.error("Erro ao escrever sent.txt:", e);
        }
      } else {
        // if r2 was "closed", we already incremented closed; if it was a fail we incremented fail above
        // nothing to write into sent.txt
      }

      saveState(state);
      // update embed non-blocking
      updateProgressEmbed().catch(() => {});
      await wait(DELAY_BASE + Math.floor(Math.random() * 400));
    }
  } catch (err) {
    console.error("Erro no worker:", err);
  } finally {
    console.log("Worker finalizado.");
    workerRunning = false;
    await finalizeSending();
  }
}

function startWorkerSafe() {
  if (workerRunning) {
    console.log("Worker já rodando — ignorando start.");
    return;
  }
  workerRunning = true;
  workerLoop().catch(err => { console.error("Worker exception:", err); workerRunning = false; });
}

// === Finalize logic: send embed + maybe sent.txt ===
async function finalizeSending() {
  // ensure we stop updater
  stopProgressUpdater();

  const chRef = state.progressMessageRef;
  if (!chRef) {
    // nothing to report
    state.active = false;
    saveState(state);
    // Clean sent.txt if no need: if file exists and fail==0, remove it
    if (fs.existsSync(SENT_FILE) && state.stats.fail === 0) {
      try { fs.unlinkSync(SENT_FILE); } catch(e) {}
    }
    return;
  }

  // build embed
  const embed = new EmbedBuilder()
    .setTitle("📬 Envio Finalizado")
    .setColor(state.stats.fail > 0 ? 0xFF0000 : 0x00AEEF)
    .addFields(
      { name: "Enviadas", value: `${state.stats.success}`, inline: true },
      { name: "Falhas", value: `${state.stats.fail}`, inline: true },
      { name: "DM Fechada", value: `${state.stats.closed}`, inline: true }
    )
    .setTimestamp();

  // decide on sending sent.txt
  const hasSentFile = fs.existsSync(SENT_FILE);
  let attachments = [];
  if (state.stats.fail > 0 && hasSentFile) {
    attachments.push(SENT_FILE);
  } else {
    // if no fail, remove sent file if exists (not useful)
    if (hasSentFile) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
  }

  try {
    const ch = await client.channels.fetch(chRef.channelId).catch(() => null);
    if (!ch) {
      state.active = false;
      saveState(state);
      return;
    }
    const msg = await ch.messages.fetch(chRef.messageId).catch(() => null);
    if (msg) {
      const content = state.stats.fail > 0 ? "⚠️ Houve falhas reais. Envio da lista dos que já receberam em anexo." : "✔️ Envio concluído.";
      await msg.edit({ content, embeds: [embed], files: attachments });
    } else {
      // send a new message if original not found
      const content = state.stats.fail > 0 ? "⚠️ Houve falhas reais. Envio da lista dos que já receberam em anexo." : "✔️ Envio concluído.";
      await ch.send({ content, embeds: [embed], files: attachments });
    }
  } catch (e) {
    console.error("Erro ao publicar resumo final:", e);
  } finally {
    // if we sent attachment, remove file afterwards
    if (attachments.length > 0) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
    // mark inactive and persist
    state.active = false;
    saveState(state);
  }
}

// === Commands and flow ===
client.on("messageCreate", async (message) => {
  try {
    if (!message.content.startsWith("!announce") && !message.content.startsWith("!announcefor")) return;
    if (message.author.bot) return;

    // prevent starting a new run if active
    if (state.active) {
      return message.reply("❗ Já existe um envio em andamento. Aguarde ou reinicie o bot.");
    }

    const mode = message.content.startsWith("!announcefor") ? "for" : "announce";
    const raw = message.content.replace("!announcefor", "").replace("!announce", "").trim();
    const parsed = parseSelectors(raw);

    // attachments urls (we send as URLs in payload.files which discord.js will fetch automatically if permitted)
    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!parsed.cleaned && attachments.length === 0) {
      return message.reply("Use `!announce texto -{id}` ou `!announcefor texto +{id}`");
    }

    const guild = message.guild;
    if (!guild) return message.reply("Comando deve ser usado dentro de um servidor.");

    // try to fetch members to populate cache (may require privileged intent)
    try { await guild.members.fetch(); } catch (e) { console.warn("guild.members.fetch() falhou (intents?). Continuando com cache."); }

    // build queue from cache applying selectors
    const queue = [];
    guild.members.cache.forEach(m => {
      if (!m || !m.user) return;
      if (m.user.bot) return;
      if (mode === "announce" && parsed.ignore.has(m.id)) return;
      if (mode === "for" && !parsed.only.has(m.id)) return;
      queue.push(m.id);
    });

    // clear any previous sent file for this run
    if (fs.existsSync(SENT_FILE)) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }

    // set state
    state = {
      active: true,
      guildId: guild.id,
      text: parsed.cleaned,
      mode,
      attachments,
      ignore: [...parsed.ignore],
      only: [...parsed.only],
      queue,
      stats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null
    };
    saveState(state);

    // send initial progress message and keep reference
    const progressMsg = await message.reply("📢 Preparando envio…");
    state.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
    saveState(state);

    await wait(700);
    try { await progressMsg.edit("🔄 Envio iniciado em modo seguro."); } catch (e) {}

    // start updater and worker
    startProgressUpdater();
    startWorkerSafe();

  } catch (err) {
    console.error("Erro em messageCreate:", err);
  }
});

// === Ready / auto-resume ===
client.on("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);

  // restore runtime msg reference if present
  if (state.progressMessageRef && state.progressMessageRef.channelId && state.progressMessageRef.messageId) {
    try {
      const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        if (msg) progressMessageRuntime = msg;
      }
    } catch (e) { /* ignore */ }
  }

  if (state.active && !workerRunning && state.queue && state.queue.length > 0) {
    console.log("Retomando envio pendente...");
    startProgressUpdater();
    startWorkerSafe();
  }
});

// ==== safety handlers ====
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));
client.on("rateLimit", (info) => console.warn("Client rateLimit event:", info));

// === login ===
if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN não encontrado.");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Falha ao logar:", err);
  process.exit(1);
});
