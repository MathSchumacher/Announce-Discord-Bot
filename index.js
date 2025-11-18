/**
 * Bot de envio em massa (versão B - otimizada)
 *
 * Instruções rápidas:
 * - Defina DISCORD_TOKEN no .env
 * - Habilite "Server Members Intent" (PANEL do Discord Developer Portal) se for usar guild.members.fetch() em servidores grandes.
 * - Valores recomendados para estabilidade: WORKERS = 1, DELAY_BASE = 1200
 * - Comande:
 *    !announce texto -{id}    -> envia para TODOS exceto -{id}
 *    !announcefor texto +{id} -> envia apenas para +{id}
 *    !announcecancel          -> cancela envio em andamento
 *
 * Arquivo: bot.js (ou index.js)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ==================== CONFIGURAÇÃO ====================
const STATE_FILE = path.resolve(__dirname, "state.json");

// Ajuste conforme necessidade / host
let WORKERS = 1;            // começar com 1 worker por segurança
let DELAY_BASE = 1200;      // 1200 ms entre envios por worker
const RETRY_LIMIT = 3;
const PROGRESS_UPDATE_INTERVAL = 5000; // atualiza embed a cada 5s
// ======================================================

// --- carregamento / salvamento de estado (somente dados serializáveis) ---
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
      // referência serializável para progress: { channelId, messageId } ou null
      progressMessageRef: null,
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
    // garantir objeto plano
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
  } catch (err) {
    console.error("Erro ao salvar state:", err);
  }
}

let state = loadState();

// ==================== CLIENT ===========================
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

// runtime-only (não salvar no disk)
let progressMessageRuntime = null;
let progressUpdaterHandle = null;
let workerRunning = false;
let workerPromises = [];

// ==================== UTIL =============================
function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

// Envio de DM com retries e tratamento básico de rate-limit
async function sendDM(user, payload) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await user.send(payload);
      return true;
    } catch (err) {
      // DM fechada
      if (err?.code === 50007) return "closed";

      // Rate limit detection (genérico)
      // Alguns erros podem expor retry_after ou status 429
      const retryAfter = err?.retry_after || err?.retryAfter || (err?.status === 429 ? (err?.rawError?.retry_after || null) : null);
      if (retryAfter) {
        const ms = Number(retryAfter) + 250;
        console.warn(`Rate limit detectado. Aguardando ${ms}ms (tentativa ${attempt}/${RETRY_LIMIT})`);
        await wait(ms);
        continue;
      }

      // se for 429 sem retry info, espera exponencial
      if (err?.status === 429 || err?.statusCode === 429) {
        const ms = 2000 * attempt;
        console.warn(`HTTP 429 recebido. Esperando ${ms}ms (tentativa ${attempt}/${RETRY_LIMIT})`);
        await wait(ms);
        continue;
      }

      // para outros erros, backoff linear
      const backoff = 1200 * attempt;
      console.warn(`Erro ao enviar DM (attempt ${attempt}): ${err?.message || err}. Aguardando ${backoff}ms.`);
      await wait(backoff);
    }
  }
  return false;
}

// parse selectors +{id} / -{id}
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

// ==================== PROGRESS EMBED ====================
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
    // mensagem deletada possivelmente
    // console.warn("Falha ao atualizar embed:", err?.message || err);
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

// ==================== WORKERS ==========================
async function workerLoop(workerId) {
  console.log(`Worker ${workerId} iniciado.`);
  try {
    while (state.active && state.queue && state.queue.length > 0) {
      const userId = state.queue.shift();
      saveState(state); // persistir progresso

      // fetch user (menos custoso que guild.members.fetch para cada id)
      let user = null;
      try {
        user = await client.users.fetch(userId).catch(() => null);
      } catch { user = null; }
      if (!user || user.bot) continue;

      // 1) Envia imagens (se houver)
      let imgResult = null;
      if (state.attachments && state.attachments.length > 0) {
        const imgPayload = { files: state.attachments };
        imgResult = await sendDM(user, imgPayload);
        if (imgResult === "closed") {
          state.stats.closed++;
          saveState(state);
          continue;
        }
        if (imgResult !== true) state.stats.fail++;
      }

      // 2) Envia texto (se houver)
      if (state.text) {
        const textPayload = { content: state.text };
        const textResult = await sendDM(user, textPayload);
        if (textResult === true) {
          state.stats.success++;
        } else if (textResult === "closed") {
          state.stats.closed++;
        } else {
          state.stats.fail++;
        }
      } else {
        // só imagem e ok
        if (imgResult === true) state.stats.success++;
      }

      saveState(state);
      await wait(DELAY_BASE);
    }
  } catch (err) {
    console.error("Erro inesperado no worker:", err);
  } finally {
    console.log(`Worker ${workerId} finalizado.`);
  }
}

// inicia workers com proteção contra múltiplas chamadas
function startWorkers() {
  if (workerRunning) {
    console.log("Workers já rodando — startWorkers ignorado.");
    return;
  }
  workerRunning = true;
  workerPromises = [];
  const n = Math.max(1, WORKERS);
  for (let i = 0; i < n; i++) {
    const p = workerLoop(i);
    workerPromises.push(p);
  }

  // quando todos terminarem, desmarca active e libera para próximo envio
  Promise.allSettled(workerPromises).then(() => {
    workerRunning = false;
    // se fila vazia, marca inactive e persiste
    if (!state.queue || state.queue.length === 0) {
      state.active = false;
      saveState(state);
      stopProgressUpdater();
      console.log("Envio finalizado — estado marcado como inactive.");
    } else {
      // se ainda tiver fila (rare), mantém active (já salvo durante processamento)
      console.log("Workers finalizados mas ainda há itens na fila (provável reinício).");
    }
  });
}

function stopWorkersImmediate() {
  // marca estado como não ativo — workers checam state.active em cada loop
  state.active = false;
  saveState(state);
  stopProgressUpdater();
  console.log("Solicitado cancelamento de envio. Workers vão encerrar após iteração atual.");
}

// ==================== EVENTS ===========================
client.on("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);

  // re-obter progressMessage se existia
  if (state.progressMessageRef && state.progressMessageRef.channelId && state.progressMessageRef.messageId) {
    try {
      const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        if (msg) progressMessageRuntime = msg;
      }
    } catch {
      // ignore
    }
  }

  // auto-resume seguro (só se não estivermos rodando)
  if (state.active && state.queue && state.queue.length > 0 && !workerRunning) {
    console.log("🔥 Retomando envio anterior...");
    startWorkers();
    startProgressUpdater();
  }
});

// Comando principal e checks
client.on("messageCreate", async (message) => {
  try {
    if (message.author?.bot) return;

    const content = message.content || "";

    // CANCELAR
    if (content.startsWith("!announcecancel")) {
      if (!state.active) return message.reply("❗ Não há nenhum envio em andamento.");
      stopWorkersImmediate();
      return message.reply("🛑 Envio cancelado. Os workers vão encerrar em breve.");
    }

    // comando principal
    if (!content.startsWith("!announce") && !content.startsWith("!announcefor")) return;

    if (state.active) {
      return message.reply("❗ Já existe um envio em andamento. Use `!announcecancel` para cancelar antes de iniciar um novo.");
    }

    const mode = content.startsWith("!announcefor") ? "for" : "announce";

    const raw = content
      .replace("!announcefor", "")
      .replace("!announce", "")
      .trim();

    const parsed = parseSelectors(raw);
    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!parsed.cleaned && attachments.length === 0) {
      return message.reply("Use `!announce texto -{id}` ou `!announcefor texto +{id}`");
    }

    // criar fila
    const guild = message.guild;
    if (!guild) return message.reply("Este comando deve ser usado em um servidor (guild).");

    // tentar fetchar membros (pode falhar se intent não habilitada)
    try {
      await guild.members.fetch();
    } catch (err) {
      console.warn("guild.members.fetch() falhou (verifique intents). Continuando com cache.");
    }

    const queue = [];
    guild.members.cache.forEach(m => {
      if (!m || !m.user) return;
      if (m.user.bot) return;
      if (mode === "announce" && parsed.ignore.has(m.id)) return;
      if (mode === "for" && !parsed.only.has(m.id)) return;
      queue.push(m.id);
    });

    // atualiza estado
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

    // mensagem de progresso (salvar referência serializável)
    const msg = await message.reply("📢 Preparando envio…");
    progressMessageRuntime = msg;
    state.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id };
    saveState(state);

    await wait(800);
    await msg.edit("🔄 Envio iniciado em modo seguro.");

    // iniciar workers e updater
    startWorkers();
    startProgressUpdater();

  } catch (err) {
    console.error("Erro em messageCreate:", err);
  }
});

// logs de segurança
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

// log de rate limit vindo do client (info útil)
client.on("rateLimit", (info) => {
  console.warn("RateLimit event:", info);
});

// ==================== START ============================
if (!process.env.DISCORD_TOKEN) {
  console.error("ERRO: DISCORD_TOKEN não encontrado nas variáveis de ambiente.");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Falha ao logar o bot:", err);
  process.exit(1);
});
