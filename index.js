require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIG =====
const WORKERS = 1; // 1 worker seguro para host free
const DELAY_BASE = 2500; // ms entre envios (ajuste para mais segurança)
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
      progressMessageRef: null,
      mode: "announce",
      quarantine: false
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

/** Abstração para modificar e salvar o estado em uma única operação. */
function modifyStateAndSave(callback) {
  callback(state);
  saveState(state);
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
      // Otimização 2B: Simplificado, pois memberOrUser.send() sempre existe.
      await memberOrUser.send(payload);
      return { success: true };
    } catch (err) {
      const errString = String(err?.message || err);

      if (err?.code === 50007) {
        console.log(`DM closed for ${memberOrUser.id}.`);
        return { success: false, reason: "closed" };
      }

      if (errString.includes("app-quarantine") || errString.includes("flagged by our anti-spam system")) {
        console.error(`QUARANTINE DETECTED for app. Stopping all sends. Appeal at https://dis.gd/app-quarantine`);
        modifyStateAndSave(s => s.quarantine = true);
        return { success: false, reason: "quarantine" };
      }

      const retryAfter = err?.retry_after || err?.retryAfter;
      if (retryAfter) {
        const waitMs = Number(retryAfter) * 1000 + 1500;
        console.warn(`RATE LIMITED (retry_after). Waiting ${waitMs}ms. Attempt ${attempt}/${RETRY_LIMIT}`);
        await wait(waitMs);
        continue;
      }

      if (err?.status === 429 || err?.statusCode === 429) {
        const backoffMs = (2000 * attempt) + Math.floor(Math.random() * 1000);
        console.warn(`RATE LIMITED (429). Waiting ${backoffMs}ms. Attempt ${attempt}/${RETRY_LIMIT}`);
        await wait(backoffMs);
        continue;
      }

      // Other errors
      const backoffMs = 1500 * attempt;
      console.error(`Failed to send DM to ${memberOrUser.id} (Attempt ${attempt}/${RETRY_LIMIT}): ${errString}. Retrying in ${backoffMs}ms.`);
      await wait(backoffMs);
    }
  }
  console.error(`Failed to send DM to ${memberOrUser.id} after ${RETRY_LIMIT} attempts.`);
  return { success: false, reason: "fail" };
}

// === Progress embed utils ===
async function updateProgressEmbed() {
  if (!state.progressMessageRef) return;
  
  // Otimização 4A: Reutiliza a referência em runtime se ela existir
  let msg = progressMessageRuntime;
  if (!msg) {
    try {
      const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
      progressMessageRuntime = msg; // Guarda a referência se encontrada
    } catch (e) {
      return;
    }
  }
  if (!msg) return;

  try {
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
    // Erros de edição (ex: mensagem foi apagada)
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
      const userId = state.queue[0]; // Pega o primeiro, mas ainda não remove

      // Otimização 2A: Prioriza o cache para evitar requisições
      let user = client.users.cache.get(userId);
      if (!user) {
        // Se não estiver em cache, tenta o fetch (necessário para DM)
        try {
          user = await client.users.fetch(userId).catch(() => null);
        } catch {
          user = null;
        }
      }
      
      // Se não conseguiu o usuário ou é bot, remove da fila e continua
      if (!user || user.bot) {
        modifyStateAndSave(s => s.queue.shift());
        continue;
      }

      modifyStateAndSave(s => s.queue.shift()); // Remove da fila APENAS se o fetch for bem-sucedido ou falhar

      // Images first, then text
      let imageOk = true;
      let textOk = true;

      // images
      if (state.attachments && state.attachments.length > 0) {
        const imgPayload = { files: state.attachments };
        const result = await sendDMToMember(user, imgPayload);

        if (!result.success) {
          imageOk = false;
          if (result.reason === "closed") {
            modifyStateAndSave(s => s.stats.closed++);
            await wait(DELAY_BASE);
            continue;
          } else if (result.reason === "quarantine") {
            console.error("Quarantine detected; stopping worker loop.");
            modifyStateAndSave(s => s.queue.unshift(userId)); // Volta o ID para fila, mas salva o estado
            break;
          } else {
            modifyStateAndSave(s => s.stats.fail++);
            await wait(DELAY_BASE);
            continue;
          }
        }
      }

      // text
      if (state.text) {
        // Se a imagem falhou por 'closed' (DM fechada), não tenta enviar o texto.
        if (!imageOk && result.reason === "closed") continue; 
        
        const textPayload = { content: state.text };
        const result = await sendDMToMember(user, textPayload);

        if (!result.success) {
          textOk = false;
          if (result.reason === "closed") {
            modifyStateAndSave(s => s.stats.closed++);
          } else if (result.reason === "quarantine") {
            console.error("Quarantine detected on text send; stopping worker loop.");
            modifyStateAndSave(s => s.queue.unshift(userId));
            break;
          } else {
            modifyStateAndSave(s => s.stats.fail++);
          }
        }
      }

      const wasSuccess = imageOk && textOk;

      if (wasSuccess) {
        modifyStateAndSave(s => s.stats.success++);
        
        // Otimização 3A: Formato do sent.txt simplificado para ser apenas o ID
        fs.appendFile(SENT_FILE, `${userId}\n`, (err) => {
          if (err) console.error("Erro ao escrever sent.txt:", err);
        });
      } else if (!wasSuccess && imageOk && !textOk) {
        // Se a imagem foi enviada, mas o texto falhou (erro de rede/api, não closed/quarantine), ainda conta como falha
        // A contagem de falha já está no bloco de texto, não precisa de mais nada aqui.
      }

      // non-blocking embed update
      updateProgressEmbed().catch(() => {});
      await wait(DELAY_BASE + Math.floor(Math.random() * 1500));
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
  
  // Limpa a referência em runtime após parar o updater
  progressMessageRuntime = null;

  const chRef = state.progressMessageRef;
  const { success, fail, closed } = state.stats;

  // Ensure sent file handling according to rules:
  const hasSentFile = fs.existsSync(SENT_FILE);
  let attachments = [];
  if (fail > 0 && hasSentFile) {
    attachments.push({ attachment: SENT_FILE, name: "sucessos.txt" }); // Nome mais claro
  } else {
    // if no fail, remove sent file if exists (not useful)
    if (hasSentFile) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
  }

  // Build embed (nice)
  const embed = new EmbedBuilder()
    .setTitle("📬 Envio Finalizado")
    .setColor(fail > 0 || state.quarantine ? 0xFF0000 : 0x00AEEF)
    .addFields(
      { name: "Enviadas (Sucesso Total)", value: `${success}`, inline: true }, // Título mais descritivo
      { name: "Falhas (API/Erro)", value: `${fail}`, inline: true },
      { name: "DM Fechada", value: `${closed}`, inline: true }
    )
    .setTimestamp();

  // Quarantine message override
  if (state.quarantine) {
    embed.addFields({ name: "⚠️ QUARENTENA ATIVADA", value: "Seu bot foi marcado pelo sistema anti-spam do Discord (app-quarantine). Todos os envios foram interrompidos. Abra um ticket/appeal: https://dis.gd/app-quarantine", inline: false });
  }
  
  // Texto de resumo
  const content = fail > 0 ? "⚠️ Houve falhas. A lista de **sucessos** está em anexo." : (state.quarantine ? "❗ Envio interrompido por quarentena. Verifique o link no embed." : "✔️ Envio concluído com sucesso.");

  // publish to same message (or channel) where progress was shown
  try {
    if (chRef && chRef.channelId) {
      const ch = await client.channels.fetch(chRef.channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(chRef.messageId).catch(() => null);
        
        if (msg) {
          await msg.edit({ content, embeds: [embed], files: attachments }).catch(async (e) => {
            console.warn("Não foi possível editar mensagem de progresso, enviando novo resumo.", e);
            await ch.send({ content, embeds: [embed], files: attachments }).catch(() => {});
          });
        } else {
          // Fallback: enviar como nova mensagem no canal
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
    // cleanup sent.txt: se anexamos (attachments > 0) ou se ele ainda existir e não for necessário (sem falha)
    if (fs.existsSync(SENT_FILE)) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
    
    modifyStateAndSave(s => s.active = false);
    // Note: O state já é salvo com active=false no modifyStateAndSave
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
      return message.reply("Use `!announce texto -{id}` para ignorar, ou `!announcefor texto +{id}` para enviar apenas para IDs específicos.");
    }

    const guild = message.guild;
    if (!guild) return message.reply("Comando deve ser usado dentro de um servidor.");

    // try to fetch members to populate cache (may require privileged intent)
    // Tentar o fetch para garantir que o cache de membros esteja o mais completo possível antes de montar a fila.
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
    modifyStateAndSave(s => s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id });

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

  // Otimização 4A: Busca a referência do runtime apenas uma vez no Ready
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