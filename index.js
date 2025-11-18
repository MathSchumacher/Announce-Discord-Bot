require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIGS SENSÍVEIS =====
let WORKERS = 1;            // começar com 1 worker para evitar bursts
let DELAY_BASE = 1000;      // 1000ms (1s) por usuário - ajustável
const RETRY_LIMIT = 3;
const CHUNK_SIZE = 1000;
const PROGRESS_UPDATE_INTERVAL = 5000; // atualiza embed a cada 5s
const STATE_FILE = path.resolve(__dirname, "state.json");
// =============================

// Carrega estado persistente
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    // certifica que campos existam
    return Object.assign({
      active: false,
      guildId: null,
      text: "",
      attachments: [],
      ignore: [],
      only: [],
      queue: [],
      stats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null, // { channelId, messageId } ou null
      mode: "announce"
    }, s);
  } catch (err) {
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

function saveState(state) {
  try {
    // criar uma cópia sem objetos não-serializáveis
    const copy = Object.assign({}, state);
    // garantir que progressMessageRef é serializável
    if (copy.progressMessage && typeof copy.progressMessage !== "string") {
      // remover se existir por engano
      delete copy.progressMessage;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));
  } catch (err) {
    console.error("Erro ao salvar state:", err);
  }
}

let state = loadState();

// Criação do client
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

// pegar a referência do message em runtime (não salvar o objeto no estado)
let progressMessageRuntime = null;

client.on("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);

  // Re-obter progressMessage se havia
  if (state.progressMessageRef && state.progressMessageRef.channelId && state.progressMessageRef.messageId) {
    try {
      const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        if (msg) progressMessageRuntime = msg;
      }
    } catch (err) {
      // ignore
    }
  }

  // AUTO-RESUME
  if (state.active && state.queue && state.queue.length > 0) {
    console.log("🔥 Retomando envio anterior...");
    startWorkers();
    startProgressUpdater();
  }
});

// ========= Utils =========
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function sendDM(userOrMember, payload) {
  for (let a = 1; a <= RETRY_LIMIT; a++) {
    try {
      // userOrMember pode ser User ou GuildMember
      const target = userOrMember.send ? userOrMember : null;
      if (target) {
        await userOrMember.send(payload);
      } else {
        // supõe user object
        await userOrMember.send(payload);
      }
      return true;
    } catch (err) {
      // se for DM fechada
      if (err?.code === 50007) return "closed";
      // se for rate limit com retry_after (alguns wrappers retornam err.rateLimit || err.retry_after)
      if (err?.retry_after) {
        const ms = Number(err.retry_after) + 250;
        console.warn(`Rate limit detectado. Esperando ${ms}ms antes de tentar de novo...`);
        await wait(ms);
        continue;
      }
      // se DiscordAPIError com status 429
      if (err?.status === 429 || err?.statusCode === 429) {
        const waitFor = (err?.retry_after ? Number(err.retry_after) : 2000) + 250;
        console.warn(`HTTP 429 recebido. Esperando ${waitFor}ms (tentativa ${a}/${RETRY_LIMIT})`);
        await wait(waitFor);
        continue;
      }
      // para outros erros, aguarda um pouco exponencial
      await wait(1200 * a);
    }
  }
  return false;
}

function parseSelectors(text) {
  const ignore = new Set();
  const only = new Set();
  const regex = /([+-])\{(\d{5,30})\}/g;

  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m[1] === "-") ignore.add(m[2]);
    if (m[1] === "+") only.add(m[2]);
  }

  return {
    cleaned: text.replace(regex, "").trim(),
    ignore,
    only
  };
}

// ========= Embed de Progresso =========
async function updateProgressEmbed() {
  if (!progressMessageRuntime) return;

  const embed = new EmbedBuilder()
    .setTitle("📨 Envio em progresso")
    .setColor("#00AEEF")
    .addFields(
      { name: "Enviadas", value: `${state.stats.success}`, inline: true },
      { name: "Falhas", value: `${state.stats.fail}`, inline: true },
      { name: "DM fechada", value: `${state.stats.closed}`, inline: true },
      { name: "Restando", value: `${state.queue.length}`, inline: true }
    )
    .setTimestamp();

  try {
    await progressMessageRuntime.edit({ embeds: [embed] });
  } catch (err) {
    // pode falhar se a mensagem foi deletada
    // console.warn("Não foi possível atualizar embed de progresso:", err?.message || err);
  }
}

let progressUpdaterHandle = null;
function startProgressUpdater() {
  if (progressUpdaterHandle) return;
  progressUpdaterHandle = setInterval(() => {
    if (!state.active) return;
    updateProgressEmbed();
  }, PROGRESS_UPDATE_INTERVAL);
}

// ========= WORKERS =========
let workerHandles = [];
let workerRunning = false;

async function workerLoop(id) {
  console.log(`Worker ${id} iniciado.`);

  while (state.active && state.queue.length > 0) {
    const userId = state.queue.shift();
    saveState(state);

    // fetch user (menos pesado que guild.members.fetch repetido)
    let user = null;
    try {
      user = await client.users.fetch(userId).catch(() => null);
    } catch { user = null; }

    if (!user) continue;

    // ignora bots (só por segurança)
    if (user.bot) continue;

    // --- 1) Enviar IMAGENS (se houver) ---
    let result = null;
    if (state.attachments && state.attachments.length > 0) {
      const imgPayload = { files: state.attachments };
      result = await sendDM(user, imgPayload);
      if (result === "closed") {
        state.stats.closed++;
        saveState(state);
        continue;
      }
      if (result !== true) state.stats.fail++;
    }

    // --- 2) Enviar TEXTO (se houver) ---
    if (state.text) {
      const textPayload = { content: state.text };
      const result2 = await sendDM(user, textPayload);
      if (result2 === true) {
        state.stats.success++;
      } else if (result2 === "closed") {
        state.stats.closed++;
      } else {
        state.stats.fail++;
      }
    } else {
      if (result === true) state.stats.success++;
    }

    saveState(state);
    await wait(DELAY_BASE);
  }

  console.log(`Worker ${id} finalizado.`);
}

function startWorkers() {
  if (workerRunning) return;
  workerRunning = true;
  for (let i = 0; i < Math.max(1, WORKERS); i++) {
    const handle = workerLoop(i).catch(err => console.error("Erro no worker:", err));
    workerHandles.push(handle);
  }
}

// ========= COMANDO PRINCIPAL =========
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!announce") &&
      !message.content.startsWith("!announcefor"))
    return;

  if (message.author.bot) return;

  const mode = message.content.startsWith("!announcefor") ? "for" : "announce";

  const raw = message.content
    .replace("!announcefor", "")
    .replace("!announce", "")
    .trim();

  const parsed = parseSelectors(raw);

  const attachments = [...message.attachments.values()].map(a => a.url);

  if (!parsed.cleaned && attachments.length === 0)
    return message.reply("Use `!announce texto -{id}` ou `!announcefor texto +{id}`");

  // Criar nova fila
  const guild = message.guild;

  // tenta fazer cache de membros (pode requerer privileged intent)
  try {
    await guild.members.fetch();
  } catch (err) {
    console.warn("Falha ao fetchar membros automaticamente. Verifique intents no Developer Portal se necessário.");
  }

  let queue = [];

  guild.members.cache.forEach(m => {
    if (m.user.bot) return;
    if (mode === "announce" && parsed.ignore.has(m.id)) return;
    if (mode === "for" && !parsed.only.has(m.id)) return;
    queue.push(m.id);
  });

  // Estado persistente (salvar somente ids e referências simples)
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

  // Envia a mensagem de progresso (salva apenas referência)
  const msg = await message.reply("📢 Preparando envio…");
  progressMessageRuntime = msg;
  state.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id };
  saveState(state);

  await wait(800);

  await msg.edit("🔄 Envio iniciado em modo seguro.");

  // INICIA TUDO
  startWorkers();
  startProgressUpdater();
});

// handlers básicos de log/segurança
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

// opcional: log de rateLimit do client
client.on("rateLimit", (info) => {
  console.warn("RateLimit:", info);
});

// ========= LOGIN =========
if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN não encontrado nas variáveis de ambiente!");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
