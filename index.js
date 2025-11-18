require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIG =====
const WORKERS = 1; 
const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const SENT_FILE = path.resolve(__dirname, "sent.txt");
const PROGRESS_UPDATE_INTERVAL = 5000;

// === CONFIGURAÇÕES DE SEGURANÇA (ANTI-QUARENTENA) ===
// NOVO DELAY: 10 segundos (base) + 0 a 10 segundos (aleatório) = 10s a 20s por DM
const DELAY_BASE_MS = 10000; 
const DELAY_RANDOM_MS = 10000; 
const BATCH_SIZE = 25; // O bot enviará no máximo 25 DMs em um lote
const BATCH_PAUSE_MINUTES = 10; // Pausa de 10 minutos entre os lotes

// === CONFIG DE SEGURANÇA ANTIS-SPAM (COOLDOWN DINÂMICO) ===
const GLOBAL_COOLDOWN_MIN_HOURS = 6; // Mínimo de descanso absoluto
const GLOBAL_COOLDOWN_MIN_MS = GLOBAL_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 1000; // 1 segundo de penalidade por usuário enviado
// ===================

// === State persistence ===
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    return Object.assign({
      active: false,
      text: "",
      attachments: [],
      ignore: [],
      only: [],
      queue: [],
      currentRunStats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null,
      mode: "announce",
      quarantine: false,
      currentAnnounceGuildId: null,
      guildData: {} 
    }, s);
  } catch {
    return {
      active: false,
      text: "",
      attachments: [],
      ignore: [],
      only: [],
      queue: [],
      currentRunStats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null,
      mode: "announce",
      quarantine: false,
      currentAnnounceGuildId: null,
      guildData: {}
    };
  }
}

function saveState(s) {
  try {
    const copy = {
      active: !!s.active,
      currentAnnounceGuildId: s.currentAnnounceGuildId || null,
      text: s.text || "",
      attachments: Array.isArray(s.attachments) ? s.attachments : [],
      ignore: Array.isArray(s.ignore) ? s.ignore : [],
      only: Array.isArray(s.only) ? s.only : [],
      queue: Array.isArray(s.queue) ? s.queue : [],
      currentRunStats: s.currentRunStats || { success: 0, fail: 0, closed: 0 },
      progressMessageRef: (s.progressMessageRef && s.progressMessageRef.channelId && s.progressMessageRef.messageId) ? s.progressMessageRef : null,
      mode: s.mode || "announce",
      quarantine: !!s.quarantine,
      guildData: s.guildData || {}
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));
  } catch (e) {
    console.error("Erro ao salvar state:", e);
  }
}

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

// Garante que cada DM tenha um hash ligeiramente diferente, evitando detecção de spam de conteúdo idêntico.
function getVariedText(baseText) {
  if (!baseText || baseText.length === 0) return "";

  // Regex para detectar se o texto termina com uma URL.
  const urlRegex = /(https?:\/\/[^\s]+)$/;
  const match = baseText.match(urlRegex);

  // Adiciona 1 a 3 caracteres de espaço de largura zero (\u200B).
  const zeroWidthSpace = "\u200B";
  const randomSuffix = Array(Math.floor(Math.random() * 3) + 1).fill(zeroWidthSpace).join('');

  // Se o texto terminar com uma URL, adiciona um espaço antes do caractere invisível para não quebrar o link.
  // Caso contrário, apenas adiciona o caractere invisível no final.
  return match ? `${baseText} ${randomSuffix}` : `${baseText}${randomSuffix}`;
}

// send DM with retry/backoff and quarantine detection
async function sendDMToMember(memberOrUser, payload) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
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
        // Penalidade adicional para 429 explícito
        const backoffMs = (5000 * attempt) + Math.floor(Math.random() * 2000); 
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
  
  let msg = progressMessageRuntime;
  if (!msg) {
    try {
      const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
      progressMessageRuntime = msg;
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
        { name: "Enviadas", value: `${state.currentRunStats.success}`, inline: true },
        { name: "Falhas", value: `${state.currentRunStats.fail}`, inline: true },
        { name: "DM Fechada", value: `${state.currentRunStats.closed}`, inline: true },
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
    let messagesSentInBatch = 0;
    
    // Prepara o texto variado APENAS UMA VEZ para este lote.
    const variedText = getVariedText(state.text); 

    while (state.active && state.queue && state.queue.length > 0) {
      const userId = state.queue[0];

      let user = client.users.cache.get(userId);
      if (!user) {
        try {
          user = await client.users.fetch(userId).catch(() => null);
        } catch {
          user = null;
        }
      }
      
      if (!user || user.bot) {
        modifyStateAndSave(s => s.queue.shift());
        continue;
      }

      modifyStateAndSave(s => s.queue.shift());

      let imageOk = true;
      let textOk = true;

      // 1. Envio de ANEXOS (Se existirem)
      if (state.attachments && state.attachments.length > 0) {
        const imgPayload = { files: state.attachments };
        const result = await sendDMToMember(user, imgPayload);

        if (!result.success) {
          imageOk = false;
          // Se falhou por closed/quarantine, não tenta enviar o texto e avança.
          if (result.reason === "closed") {
            modifyStateAndSave(s => s.currentRunStats.closed++);
          } else if (result.reason === "quarantine") {
            modifyStateAndSave(s => s.queue.unshift(userId)); 
            break;
          } else {
            modifyStateAndSave(s => s.currentRunStats.fail++);
          }
          // Já faz o delay e continua para o próximo, não passa para o texto.
          await wait(DELAY_BASE_MS + Math.floor(Math.random() * DELAY_RANDOM_MS));
          continue;
        }
      }

      // 2. Envio de TEXTO (Se existir e o envio de anexo não falhou de forma terminal)
      if (state.text) {
        // Usa o texto variado
        const textPayload = { content: variedText };
        const result = await sendDMToMember(user, textPayload);

        if (!result.success) {
          textOk = false;
          if (result.reason === "closed") {
            modifyStateAndSave(s => s.currentRunStats.closed++);
          } else if (result.reason === "quarantine") {
            console.error("Quarantine detected on text send; stopping worker loop.");
            modifyStateAndSave(s => s.queue.unshift(userId)); 
            break;
          } else {
            modifyStateAndSave(s => s.currentRunStats.fail++);
          }
        }
      }

      const wasSuccess = imageOk && textOk;

      if (wasSuccess) {
        modifyStateAndSave(s => s.currentRunStats.success++);
        
        fs.appendFile(SENT_FILE, `${userId}\n`, (err) => {
          if (err) console.error("Erro ao escrever sent.txt:", err);
        });
      }

      updateProgressEmbed().catch(() => {});
      
      // 3. Lógica de delay e pausa de lote
      messagesSentInBatch++;
      if (messagesSentInBatch >= BATCH_SIZE && state.queue.length > 0) {
        console.log(`PAUSA DE LOTE: ${messagesSentInBatch} DMs enviadas. Pausando por ${BATCH_PAUSE_MINUTES} minutos.`);
        await updateProgressEmbed();
        await wait(BATCH_PAUSE_MINUTES * 60 * 1000);
        messagesSentInBatch = 0;
        console.log("Retomando envio após a pausa.");
      } else {
        // Delay normal entre mensagens
        await wait(DELAY_BASE_MS + Math.floor(Math.random() * DELAY_RANDOM_MS));
      }
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
  progressMessageRuntime = null;

  const currentAnnounceGuildId = state.currentAnnounceGuildId;
  const chRef = state.progressMessageRef;
  const { success, fail, closed } = state.currentRunStats;
  const totalSent = success + fail + closed;

  const hasSentFile = fs.existsSync(SENT_FILE);
  let attachments = [];
  if (fail > 0 && hasSentFile) {
    attachments.push({ attachment: SENT_FILE, name: "sucessos.txt" });
  } else {
    if (hasSentFile) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("📬 Envio Finalizado")
    .setColor(fail > 0 || state.quarantine ? 0xFF0000 : 0x00AEEF)
    .addFields(
      { name: "Enviadas (Sucesso Total)", value: `${success}`, inline: true },
      { name: "Falhas (API/Erro)", value: `${fail}`, inline: true },
      { name: "DM Fechada", value: `${closed}`, inline: true }
    )
    .setTimestamp();
 
  if (state.quarantine) {
    embed.addFields({ name: "⚠️ QUARENTENA ATIVADA", value: "Seu bot foi marcado pelo sistema anti-spam do Discord (app-quarantine). Todos os envios foram interrompidos. Abra um ticket/appeal: https://dis.gd/app-quarantine", inline: false });
  }
  
  const content = fail > 0 ? "⚠️ Houve falhas. A lista de **sucessos** está em anexo." : (state.quarantine ? "❗ Envio interrompido por quarentena. Verifique o link no embed." : "✔️ Envio concluído com sucesso.");

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
          await ch.send({ content, embeds: [embed], files: attachments }).catch(() => {});
        }
      } else {
        console.warn("Canal de progresso não disponível para postar resumo final.");
      }
    } else {
      console.warn("Sem referência de progresso para postar resumo final.");
    }
  } catch (e) {
    console.error("Erro ao publicar resumo final:", e);
  } finally {
    if (fs.existsSync(SENT_FILE)) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }
    
    // === Lógica de Cooldown na Finalização ===
    const wasQueueEmpty = state.queue.length === 0;
    
    if (currentAnnounceGuildId && !state.quarantine && wasQueueEmpty && totalSent > 0) {
        modifyStateAndSave(s => {
            s.guildData[currentAnnounceGuildId] = s.guildData[currentAnnounceGuildId] || { lastAnnounceTime: 0, totalSuccess: 0, totalFail: 0, totalClosed: 0 };
            s.guildData[currentAnnounceGuildId].lastAnnounceTime = Date.now();
            // Estatísticas para o próximo cálculo de cooldown
            s.guildData[currentAnnounceGuildId].totalSuccess = success;
            s.guildData[currentAnnounceGuildId].totalFail = fail;
            s.guildData[currentAnnounceGuildId].totalClosed = closed;

            s.active = false;
            s.currentAnnounceGuildId = null;
        });
    } else {
        modifyStateAndSave(s => s.active = false);
    }
  }
}

// === Commands and flow ===
client.on("messageCreate", async (message) => {
  try {
    if (!message.content.startsWith("!announce") && !message.content.startsWith("!announcefor")) return;
    if (message.author.bot || !message.guild) return;

    // 1. Prevenção de Cooldown Global Dinâmico (Por Guild)
    const guildId = message.guild.id;

    if (!state.guildData[guildId]) {
      modifyStateAndSave(s => s.guildData[guildId] = { lastAnnounceTime: 0, totalSuccess: 0, totalFail: 0, totalClosed: 0 });
    }
    const guildSpecificData = state.guildData[guildId];

    const now = Date.now();
    const timeSinceLastAnnounce = now - guildSpecificData.lastAnnounceTime;
    
    // Usa o resultado da última campanha (armazenado no guildData após a última finalização)
    const lastCampaignSize = guildSpecificData.totalSuccess + guildSpecificData.totalClosed + guildSpecificData.totalFail;
    
    let requiredCooldownMs = GLOBAL_COOLDOWN_MIN_MS;
    if (lastCampaignSize > 0) {
        requiredCooldownMs = Math.max(
            GLOBAL_COOLDOWN_MIN_MS, 
            lastCampaignSize * COOLDOWN_PENALTY_MS_PER_USER
        );
    }

    if (guildSpecificData.lastAnnounceTime !== 0 && timeSinceLastAnnounce < requiredCooldownMs) {
      const remainingTimeMs = requiredCooldownMs - timeSinceLastAnnounce;
      
      const remainingHours = Math.floor(remainingTimeMs / 3600000);
      const remainingMinutes = Math.ceil((remainingTimeMs % 3600000) / 60000);
      
      let remainingDisplay = "";
      if (remainingHours > 0) remainingDisplay += `${remainingHours} horas`;
      if (remainingMinutes > 0) {
          if (remainingDisplay) remainingDisplay += ` e `;
          remainingDisplay += `${remainingMinutes} minutos`;
      }

      const penaltyDurationHours = (requiredCooldownMs / 3600000).toFixed(1);
      
      return message.reply(`⛔ Cooldown Ativo. O último envio de **${lastCampaignSize} DMs** exige um descanso de **${penaltyDurationHours} horas** (anti-spam). Restam **${remainingDisplay}**.`);
    }

    // 2. Prevenção de Múltiplas Execuções Concorrentes (Global)
    if (state.active) {
      return message.reply("❗ Já existe um envio em andamento **GLOBALMENTE**. Aguarde a conclusão da tarefa atual.");
    }

    const mode = message.content.startsWith("!announcefor") ? "for" : "announce";
    const raw = message.content.replace("!announcefor", "").replace("!announce", "").trim();
    const parsed = parseSelectors(raw);

    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!parsed.cleaned && attachments.length === 0) {
      return message.reply("O comando precisa de texto ou anexo. Use `!announce texto -{id}` ou `!announcefor texto +{id}`.");
    }

    const guild = message.guild;
    try { await guild.members.fetch(); } catch (e) { console.warn("guild.members.fetch() falhou (intents?). Continuando com cache."); }

    const queue = [];
    guild.members.cache.forEach(m => {
      if (!m || !m.user || m.user.bot) return;
      if (mode === "announce" && parsed.ignore.has(m.id)) return;
      if (mode === "for" && !parsed.only.has(m.id)) return;
      queue.push(m.id);
    });
    
    if (queue.length === 0) {
        return message.reply("A fila de envio está vazia após aplicar os filtros.");
    }

    if (fs.existsSync(SENT_FILE)) {
      try { fs.unlinkSync(SENT_FILE); } catch (e) {}
    }

    // Inicia o estado da execução
    state = {
      active: true,
      currentAnnounceGuildId: guild.id,
      text: parsed.cleaned,
      mode,
      attachments,
      ignore: [...parsed.ignore],
      only: [...parsed.only],
      queue,
      currentRunStats: { success: 0, fail: 0, closed: 0 },
      progressMessageRef: null,
      quarantine: false,
      guildData: state.guildData
    };
    saveState(state);

    const progressMsg = await message.reply(`📢 Preparando envio para **${queue.length}** membros...`);
    modifyStateAndSave(s => s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id });

    await wait(700);
    try { await progressMsg.edit("🔄 Envio iniciado em modo seguro (1 DM a cada 10s-20s)."); } catch (e) {}

    startProgressUpdater();
    startWorkerSafe();

  } catch (err) {
    console.error("Erro em messageCreate:", err);
    message.reply("❌ Ocorreu um erro interno ao iniciar o envio.");
  }
});

// === Ready / auto-resume ===
client.on("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);

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