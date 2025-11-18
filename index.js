require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIG =====
const WORKERS = 1; // 1 worker seguro para host free
const DELAY_BASE = 1200; // ms entre envios (ajuste para mais segurança)
const RETRY_LIMIT = 3;
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
      mode: "announce",
      quarantine: false // runtime flag persisted if needed
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
      mode: "announce",
      quarantine: false
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
      mode: s.mode || "announce",
      quarantine: !!s.quarantine
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

// runtime refs (not persisted)
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

// send DM with retry/backoff and quarantine detection
async function sendDMToMember(memberOrUser, payload) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await (memberOrUser.send ? memberOrUser.send(payload) : memberOrUser.send(payload));
      return true;
    } catch (err) {
      // DM closed
      if (err?.code === 50007) return "closed";

      // Detect app quarantine message (Discord anti-spam)
      const msg = String(err?.message || err);
      if (msg.includes("app-quarantine") || msg.includes("flagged by our anti-spam system")) {
        // mark quarantine in state and stop further processing
        state.quarantine = true;
        saveState(state);
        console.error("DETECTED APP-QUARANTINE from Discord API:", msg);
        return "quarantine";
      }

      // retry_after if provided
      const retryAfter = err?.retry_after || err?.retryAfter || null;
      if (retryAfter) {
        const ms = Number(retryAfter) + 300;
        console.warn(`Rate limited, waiting ${ms}ms (attempt ${attempt})`);
        await wait(ms);
        continue;
      }

      // generic 429
      if (err?.status === 429 || err?.statusCode === 429) {
        const back = 2000 * attempt;
        console.warn(`HTTP 429, waiting ${back}ms (attempt ${attempt})`);
        await wait(back);
        continue;
      }

      // other errors -> backoff
      const backoff = 1200 * attempt;
      console.warn(`Erro ao enviar DM (attempt ${attempt}): ${msg}. Aguardando ${backoff}ms.`);
      await wait(backoff);
    }
  }
  return false;
}

// === Progress embed utils ===
async function updateProgressEmbed() {
  if (!state.progressMessageRef) return;
  try {
    const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
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
      if (!user) continue;
      if (user.bot) continue;

      // Images first, then text
      let imageOk = true;
      let textOk = true;

      // images
      if (state.attachments && state.attachments.length > 0) {
        const imgPayload = { files: state.attachments };
        const r = await sendDMToMember(user, imgPayload);
        if (r === "closed") {
          state.stats.closed++;
          saveState(state);
          await wait(DELAY_BASE);
          continue; // do not attempt text
        } else if (r === "quarantine") {
          console.error("Quarantine detected; stopping worker loop.");
          // put this user back to queue? We'll stop processing to avoid further penalties.
          // Reinsert user at front so resume will retry later.
          state.queue.unshift(userId);
          saveState(state);
          break;
        } else if (r !== true) {
          // failure on image
          state.stats.fail++;
          saveState(state);
          await wait(DELAY_BASE);
          continue; // skip text
        }
      }

      // text
      if (state.text) {
        const textPayload = { content: state.text };
        const r2 = await sendDMToMember(user, textPayload);
        if (r2 === "closed") {
          state.stats.closed++;
          textOk = false;
        } else if (r2 === "quarantine") {
          console.error("Quarantine detected on text send; stopping worker loop.");
          state.queue.unshift(userId);
          saveState(state);
          break;
        } else if (r2 !== true) {
          state.stats.fail++;
          textOk = false;
        }
      }

      const wasSuccess = ( (state.attachments.length === 0 || imageOk) && (!state.text || textOk) );

      if (wasSuccess) {
        state.stats.success++;
        // append to sent.txt in exact format -{userId}
        try {
          fs.appendFileSync(SENT_FILE, `-{${userId}}\n`);
        } catch (e) {
          console.error("Erro ao escrever sent.txt:", e);
        }
      } else {
        // nothing to append (either closed or failed)
      }

      saveState(state);
      // non-blocking embed update
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
  stopProgressUpdater();

  const chRef = state.progressMessageRef;
  const { success, fail, closed } = state.stats;

  // Ensure sent file handling according to rules:
  const hasSentFile = fs.existsSync(SENT_FILE);
  let attachments = [];
  if (fail > 0 && hasSentFile) {
    attachments.push(SENT_FILE);
  } else {
    // if no fail, remove sent file if exists (not useful)
    if (hasSentFile) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
  }

  // Build embed (nice)
  const embed = new EmbedBuilder()
    .setTitle("📬 Envio Finalizado")
    .setColor(fail > 0 ? 0xFF0000 : 0x00AEEF)
    .addFields(
      { name: "Enviadas", value: `${success}`, inline: true },
      { name: "Falhas", value: `${fail}`, inline: true },
      { name: "DM Fechada", value: `${closed}`, inline: true }
    )
    .setTimestamp();

  // Quarantine message override
  if (state.quarantine) {
    embed.addFields({ name: "⚠️ Quarantine", value: "Seu bot foi marcado pelo sistema anti-spam do Discord (app-quarantine). Abra um ticket/appeal: https://dis.gd/app-quarantine", inline: false });
  }

  // publish to same message (or channel) where progress was shown
  try {
    if (chRef && chRef.channelId) {
      const ch = await client.channels.fetch(chRef.channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(chRef.messageId).catch(() => null);
        const content = fail > 0 ? "⚠️ Houve falhas reais. Envio da lista dos que já receberam em anexo." : (state.quarantine ? "❗ Envio interrompido por quarentena. Verifique o link no embed." : "✔️ Envio concluído com sucesso.");
        if (msg) {
          await msg.edit({ content, embeds: [embed], files: attachments }).catch(async (e) => {
            console.warn("Não foi possível editar mensagem de progresso, enviando novo resumo.", e);
            await ch.send({ content, embeds: [embed], files: attachments }).catch(() => {});
          });
        } else {
          await ch.send({ content, embeds: [embed], files: attachments }).catch(() => {});
        }
      } else {
        // fallback: can't fetch channel
        console.warn("Canal de progresso não disponível para postar resumo final.");
      }
    } else {
      console.warn("Sem referência de progresso para postar resumo final.");
    }
  } catch (e) {
    console.error("Erro ao publicar resumo final:", e);
  } finally {
    // cleanup sent.txt if we attached it (we already attached) or if no fail
    if (attachments.length > 0 || (!attachments.length && fs.existsSync(SENT_FILE))) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
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

    // attachments urls
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

    // clear previous sent.txt for this run
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
      progressMessageRef: null,
      quarantine: false
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
