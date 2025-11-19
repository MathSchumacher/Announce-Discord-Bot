require("dotenv").config();
const fs = require("fs");
const path = require("path");
// Necessário para fazer download do anexo JSON
const https = require("https"); 
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require("discord.js");

// ===== CONFIG =====
const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;

// === SEGURANÇA ANTI-QUARENTENA ===
let currentDelayBase = 10000; // 10s base (dinâmico)
const DELAY_RANDOM_MS = 10000; // +0-10s aleatório
let currentBatchBase = 25; // Base para o lote (dinâmico)
const BATCH_VARIANCE = 5; // Variação do lote (entre 20 e 30)
const MIN_BATCH_PAUSE_MS = 5 * 60 * 1000; // 5 min
const MAX_BATCH_PAUSE_MS = 10 * 60 * 1000; // 10 min

// === COOLDOWN DINÂMICO ===
const GUILD_COOLDOWN_MIN_HOURS = 6;
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 1000; // +1s por usuário

// === OTIMIZAÇÃO ===
const SAVE_THRESHOLD = 10; // Salva a cada 10 mudanças
const MEMBER_CACHE_TTL = 5 * 60 * 1000; // Cache 5min
const SOFT_BAN_THRESHOLD = 0.8; // 80% DMs fechadas = soft-ban
const SOFT_BAN_MIN_SAMPLES = 20; // Mínimo 20 tentativas

// ===== STATE MANAGER =====
class StateManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.state = this.load();
        this.saveQueue = Promise.resolve();
        this.unsavedChanges = 0;
        this.setupShutdownHandler();
    }

    getInitialState() {
        return {
            active: false,
            text: "",
            attachments: [],
            ignore: new Set(),
            only: new Set(),
            queue: [],
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            quarantine: false,
            currentAnnounceGuildId: null,
            guildData: {}
        };
    }

    load(initialState = null) {
        const stateToLoad = initialState || this.getInitialState();
        try {
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            // Converte arrays para Sets
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // Converte processedMembers e garante filas
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = new Set(Array.isArray(gd.processedMembers) ? gd.processedMembers : []);
                // NOVO: Inicializa Set para DMs bloqueadas
                gd.blockedDMs = new Set(Array.isArray(gd.blockedDMs) ? gd.blockedDMs : []);
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
                gd.lastRunText = gd.lastRunText || "";
                gd.lastRunAttachments = Array.isArray(gd.lastRunAttachments) ? gd.lastRunAttachments : [];
            }

            console.log(`✅ Estado ${initialState ? "anexado" : "carregado"} com sucesso`);
            return loaded;
        } catch (e) {
            if (initialState) {
                console.error("❌ Erro ao processar JSON anexado:", e);
                return null;
            }
            console.log("ℹ️ Nenhum estado anterior encontrado, iniciando limpo");
            return this.getInitialState();
        }
    }

    save() {
        try {
            const serializable = {
                ...this.state,
                ignore: [...this.state.ignore],
                only: [...this.state.only],
                guildData: {}
            };

            for (const [id, data] of Object.entries(this.state.guildData)) {
                serializable.guildData[id] = {
                    ...data,
                    processedMembers: [...data.processedMembers],
                    // NOVO: Serializa Set de DMs bloqueadas
                    blockedDMs: [...data.blockedDMs]
                };
            }

            fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
            this.unsavedChanges = 0;
        } catch (e) {
            console.error("❌ Erro ao salvar estado:", e);
        }
    }

    async modify(callback) {
        return this.saveQueue = this.saveQueue.then(async () => {
            callback(this.state);
            this.unsavedChanges++;
            if (this.unsavedChanges >= SAVE_THRESHOLD) {
                this.save();
            }
        });
    }

    forceSave() {
        if (this.unsavedChanges > 0) {
            this.save();
        }
    }

    // Manter a função de envio de e-mail de backup e o handler de desligamento seguro (assumindo que a função sendEmail está definida no seu código completo)
    setupShutdownHandler() {
        const saveOnExit = async (signal) => {
            console.log(`\n🛑 Encerrando (${signal}) - Salvando estado...`);
            this.forceSave();
            // AQUI O CÓDIGO COMPLETO DEVE CHAMAR A FUNÇÃO DE BACKUP POR E-MAIL
            process.exit(0);
        };
        process.on('SIGINT', () => saveOnExit('SIGINT'));
        process.on('SIGTERM', () => saveOnExit('SIGTERM'));
    }
}

const stateManager = new StateManager(STATE_FILE);

// === CLIENT ===
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

let progressMessageRuntime = null;
let progressUpdaterHandle = null;
let workerRunning = false;
let lastEmbedState = null;
const memberCache = new Map();

// ===== UTILIDADES =====
const wait = ms => new Promise(r => setTimeout(r, ms));

function randomizeParameters() {
    // Flutua a base de delay entre 8s e 15s
    currentDelayBase = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
    
    // Flutua a base do lote entre 15 e 30
    currentBatchBase = Math.floor(Math.random() * (30 - 15 + 1)) + 15;
    
    console.log(`🎲 Humanizer: Novo ritmo definido (Base Delay: ${currentDelayBase/1000}s, Base Batch: ${currentBatchBase})`);
}

function getNextBatchSize() {
    // Retorna um número aleatório baseado na base atual
    const min = currentBatchBase - BATCH_VARIANCE;
    const max = currentBatchBase + BATCH_VARIANCE;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseSelectors(text) {
    const ignore = new Set();
    const only = new Set();
    const regex = /([+-])\{(\d{5,30})\}/g;
    let m;
    
    while ((m = regex.exec(text))) {
        if (m[1] === '-') ignore.add(m[2]);
        if (m[1] === '+') only.add(m[2]);
    }
    
    const cleaned = text.replace(regex, "").trim();
    const hasForce = /\bforce\b/i.test(cleaned);
    const finalText = hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned;
    
    return { cleaned: finalText, ignore, only, hasForce };
}

function getVariedText(text) {
    if (!text || text.includes("http")) return text || "";
    return `${text}\u200B\u200B`; // 2 espaços invisíveis
}

function validateAttachments(attachments) {
    const MAX_SIZE = 8 * 1024 * 1024; // 8MB
    const ALLOWED = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.pdf', '.webm'];
    
    for (const att of attachments) {
        if (att.size > MAX_SIZE) {
            return { valid: false, error: `❌ Arquivo "${att.name}" excede 8MB` };
        }
        const ext = path.extname(att.name).toLowerCase();
        if (!ALLOWED.includes(ext)) {
            return { valid: false, error: `❌ Tipo não permitido: ${ext}` };
        }
    }
    
    return { valid: true };
}

async function getCachedMembers(guild) {
    const cached = memberCache.get(guild.id);
    if (cached && Date.now() - cached.timestamp < MEMBER_CACHE_TTL) {
        return cached.members;
    }
    
    try {
        await guild.members.fetch();
    } catch (e) {
        console.warn("⚠️ Falha ao buscar membros:", e.message);
    }
    
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

function detectSoftBan(stats) {
    const total = stats.success + stats.fail + stats.closed;
    if (total < SOFT_BAN_MIN_SAMPLES) return false;
    return stats.closed / total >= SOFT_BAN_THRESHOLD;
}

async function sendDM(user, payload) {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await user.send(payload);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            
            // DM fechada (erro 50007)
            if (err.code === 50007) {
                return { success: false, reason: "closed" };
            }
            
            // Quarentena detectada
            if (errMsg.includes("quarantine") || errMsg.includes("flagged") || errMsg.includes("spam")) {
                console.error("🚨 QUARENTENA DETECTADA");
                await stateManager.modify(s => s.quarantine = true);
                return { success: false, reason: "quarantine" };
            }
            
            // Rate limit com retry_after
            if (err.retry_after) {
                const waitTime = err.retry_after * 1000 + 1500;
                console.warn(`⏳ Rate limit: aguardando ${waitTime}ms (${attempt}/${RETRY_LIMIT})`);
                await wait(waitTime);
                continue;
            }
            
            // Rate limit 429
            if (err.status === 429 || err.statusCode === 429) {
                const backoff = 5000 * attempt + Math.floor(Math.random() * 3000);
                console.warn(`⏳ 429 detectado: aguardando ${backoff}ms (${attempt}/${RETRY_LIMIT})`);
                await wait(backoff);
                continue;
            }
            
            // Outros erros - backoff exponencial
            const backoff = 1500 * attempt;
            console.error(`❌ Erro DM (${attempt}/${RETRY_LIMIT}): ${err.message}`);
            if (attempt < RETRY_LIMIT) {
                await wait(backoff);
            }
        }
    }
    
    return { success: false, reason: "fail" };
}

/**
 * Lê e tenta parsear um arquivo JSON anexado a uma mensagem.
 */
async function readAttachmentJSON(message) {
    const attachment = message.attachments.first();
    // Limite de tamanho de 1MB para o arquivo de estado
    if (!attachment || !attachment.name.endsWith('.json') || attachment.size > 1024 * 1024) {
        return { success: false, error: "❌ Nenhum arquivo JSON válido anexado (máx 1MB, deve ser '.json')" };
    }
    
    return new Promise(resolve => {
        // Usa o módulo https nativo para fazer o download
        https.get(attachment.url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, state: parsed });
                } catch (e) {
                    resolve({ success: false, error: "❌ Erro ao parsear o JSON anexado. O arquivo está corrompido ou mal formatado." });
                }
            });
        }).on('error', (err) => {
            resolve({ success: false, error: `❌ Erro ao baixar o anexo: ${err.message}` });
        });
    });
}


// ===== PROGRESS EMBED =====
async function updateProgressEmbed() {
    const state = stateManager.state;
    if (!state.progressMessageRef) return;

    const currentStats = JSON.stringify(state.currentRunStats);
    if (currentStats === lastEmbedState) return; // Sem mudanças
    lastEmbedState = currentStats;

    try {
        if (!progressMessageRuntime) {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (!ch || !ch.isTextBased()) return;
            progressMessageRuntime = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        }
        
        if (!progressMessageRuntime) return;

        let remaining = state.queue.length;
        if (!state.active && state.currentAnnounceGuildId) {
            const gd = state.guildData[state.currentAnnounceGuildId] || {};
            // Restante não deve incluir blockedDMs, apenas pendingQueue e failedQueue
            remaining = (gd.pendingQueue?.length || 0) + (gd.failedQueue?.length || 0);
        }

        const embed = new EmbedBuilder()
            .setTitle("📨 Envio em Andamento")
            .setColor("#00AEEF")
            .addFields(
                { name: "✅ Sucesso", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 DM Fechada", value: `${state.currentRunStats.closed}`, inline: true },
                { name: "⏳ Restante", value: `${remaining}`, inline: true }
            )
            .setTimestamp();

        await progressMessageRuntime.edit({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        // Falha silenciosa no update
    }
}

function startProgressUpdater() {
    if (progressUpdaterHandle) return;
    progressUpdaterHandle = setInterval(() => {
        if (stateManager.state.active) {
            updateProgressEmbed();
        }
    }, PROGRESS_UPDATE_INTERVAL);
}

function stopProgressUpdater() {
    if (progressUpdaterHandle) {
        clearInterval(progressUpdaterHandle);
        progressUpdaterHandle = null;
    }
}

// ===== WORKER =====
async function workerLoop() {
    console.log("🚀 Worker iniciado");
    const state = stateManager.state;
    const guildId = state.currentAnnounceGuildId;
    const gd = state.guildData[guildId] || {};

    try {
        let sentInBatch = 0;
        let currentBatchSize = getNextBatchSize();

        while (state.active && state.queue.length > 0) {
            
            // === PAUSA DE LOTE ===
            if (sentInBatch >= currentBatchSize) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                const pauseDuration = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * pauseRange);
                const pauseMinutes = (pauseDuration / 60000).toFixed(1);
                
                console.log(`⏸️ Pausa de lote: ${sentInBatch} DMs enviadas. Pausando ~${pauseMinutes} min`);
                stateManager.forceSave();
                await updateProgressEmbed();
                await wait(pauseDuration);
                
                // Humanizer: Altera o ritmo após a pausa
                randomizeParameters();
                
                // Verifica se estado mudou durante pausa
                if (!stateManager.state.active || stateManager.state.queue.length === 0) {
                    console.log("⚠️ Estado alterado durante pausa - Saindo");
                    break;
                }
                
                // Reseta o contador e define um novo tamanho de lote
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
                console.log(`▶️ Retomando envio. Novo lote máximo: ${currentBatchSize}`);
            }

            // === PROCESSAMENTO ===
            const userId = state.queue.shift(); // Remove da fila
            await stateManager.modify(() => {}); // Incrementa contador de mudanças

            const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
            if (!user || user.bot) continue;

            let imageSuccess = true;
            let textSuccess = true;
            let failureReason = null;

            // 1. Envia anexos (se houver)
            if (state.attachments && state.attachments.length > 0) {
                const result = await sendDM(user, { files: state.attachments });
                
                if (!result.success) {
                    imageSuccess = false;
                    failureReason = result.reason;
                    
                    if (result.reason === "quarantine") {
                        console.error("🚨 Quarentena - Parando worker");
                        await stateManager.modify(s => s.active = false);
                        break;
                    }
                }
            }

            // 2. Envia texto (se anexo foi OK e há texto)
            if (imageSuccess && state.text) {
                const content = getVariedText(state.text);
                const result = await sendDM(user, { content });
                
                if (!result.success) {
                    textSuccess = false;
                    // Se a falha foi no texto, o DM fechado deve ser o motivo final, a menos que quarentena seja detectada
                    failureReason = result.reason; 
                    
                    if (result.reason === "quarantine") {
                        console.error("🚨 Quarentena - Parando worker");
                        await stateManager.modify(s => s.active = false);
                        break;
                    }
                }
            }

            // 3. Registra resultado
            const wasSuccess = imageSuccess && textSuccess;

            await stateManager.modify(s => {
                const gd = s.guildData[guildId];
                if (wasSuccess) {
                    s.currentRunStats.success++;
                    
                    // Remove da failedQueue se estava lá
                    const fq = gd?.failedQueue;
                    if (fq) {
                        const idx = fq.indexOf(userId);
                        if (idx > -1) fq.splice(idx, 1);
                    }
                } else {
                    // Registra falha
                    if (failureReason === "closed") {
                        s.currentRunStats.closed++;
                        
                        // NOVO: Marca como permanentemente processado/bloqueado
                        if (guildId && gd) {
                            gd.blockedDMs.add(userId);
                            // Adiciona ao processedMembers para que não seja re-adicionado com !update/!announce
                            gd.processedMembers.add(userId); 
                        }
                    } else {
                        s.currentRunStats.fail++;
                        
                        // Adiciona à failedQueue (sem duplicatas)
                        if (guildId && gd) {
                            const fq = gd.failedQueue;
                            if (!fq.includes(userId)) {
                                fq.push(userId);
                            }
                        }
                    }
                }
            });

            // 4. Detecta soft-ban
            if (detectSoftBan(state.currentRunStats)) {
                console.error("🚨 SOFT-BAN DETECTADO - Taxa de fechamento muito alta");
                await stateManager.modify(s => {
                    s.quarantine = true;
                    s.active = false;
                });
                break;
            }

            updateProgressEmbed().catch(() => {});
            
            // Delay entre mensagens
            await wait(currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS));
            sentInBatch++;
        }

        // Fila vazia - conclusão
        if (state.queue.length === 0 && state.active) {
            console.log("✅ Fila vazia - Finalizando");
            await finalizeSending();
        }

    } catch (err) {
        console.error("💥 Erro no worker:", err);
        stateManager.forceSave();
    } finally {
        console.log("🛑 Worker finalizado");
        workerRunning = false;
        
        const state = stateManager.state;
        const wasInterrupted = state.queue.length > 0 && (!state.active || state.quarantine);
        
        if (wasInterrupted) {
            console.log("⚠️ Worker interrompido - Finalizando");
            await finalizeSending();
        } else if (state.queue.length > 0 && state.active) {
            console.warn("⚠️ Worker parou inesperadamente - Estado preservado");
            stateManager.forceSave();
        }
    }
}

function startWorker() {
    if (workerRunning) {
        console.log("⚠️ Worker já está rodando");
        return;
    }
    workerRunning = true;
    workerLoop().catch(err => {
        console.error("💥 Worker exception:", err);
        workerRunning = false;
        stateManager.forceSave();
    });
}

// ===== FINALIZAÇÃO =====
async function finalizeSending() {
    const state = stateManager.state;
    stopProgressUpdater();
    progressMessageRuntime = null;

    const guildId = state.currentAnnounceGuildId;
    const stats = { ...state.currentRunStats };
    const progressRef = state.progressMessageRef;

    // Move fila restante para pendingQueue
    await stateManager.modify(s => {
        if (guildId && s.queue.length > 0) {
            s.guildData[guildId].pendingQueue.push(...s.queue);
        }
        s.queue = [];
        s.active = false;
    });

    stateManager.forceSave();

    // Calcula restantes
    const gd = state.guildData[guildId] || {};
    const remaining = (gd.pendingQueue?.length || 0) + (gd.failedQueue?.length || 0);

    // Embed final
    const embedColor = remaining === 0 && !state.quarantine ? 0x00FF00 : 0xFF0000;
    const embed = new EmbedBuilder()
        .setTitle("📬 Envio Finalizado")
        .setColor(embedColor)
        .addFields(
            { name: "✅ Sucesso", value: `${stats.success}`, inline: true },
            { name: "❌ Falhas", value: `${stats.fail}`, inline: true },
            { name: "🔒 DM Fechada", value: `${stats.closed}`, inline: true },
            { name: "⏳ Restante", value: `${remaining}`, inline: true }
        )
        .setTimestamp();

    if (state.quarantine) {
        embed.addFields({
            name: "🚨 QUARENTENA ATIVADA",
            value: "Bot foi flagado pelo sistema anti-spam. **Verifique seu e-mail de backup!**",
            inline: false
        });
    }

    const finalText = remaining === 0
        ? "✅ Campanha 100% concluída!"
        : `⏸️ Restam ${remaining} membros — Use \`!resume\` para continuar (ou com o anexo de backup)`;

    // Posta resumo
    if (progressRef) {
        try {
            const ch = await client.channels.fetch(progressRef.channelId).catch(() => null);
            if (ch?.isTextBased()) {
                const msg = await ch.messages.fetch(progressRef.messageId).catch(() => null);
                if (msg) {
                    await msg.edit({ content: finalText, embeds: [embed] }).catch(() => {});
                } else {
                    await ch.send({ content: finalText, embeds: [embed] }).catch(() => {});
                }
            }
        } catch (e) {
            console.error("❌ Erro ao postar resumo:", e.message);
        }
    }

    // Aplica cooldown se 100% concluído
    if (guildId && remaining === 0) {
        await stateManager.modify(s => {
            const guild = s.guildData[guildId];
            guild.lastAnnounceTime = Date.now();
            guild.totalSuccess = stats.success;
            guild.totalFail = stats.fail;
            guild.totalClosed = stats.closed;
            guild.processedMembers = new Set();
            guild.failedQueue = [];
            guild.pendingQueue = [];
            // NÃO limpa blockedDMs - eles são permanentes
        });
    }

    // Limpa referências
    await stateManager.modify(s => s.currentAnnounceGuildId = null);
    stateManager.forceSave();
}

// ===== COMANDOS =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const content = message.content.toLowerCase();
    const cmd = content.split(' ')[0];

    const isAnnounce = cmd.startsWith("!announce") || cmd.startsWith("!announcefor");
    const isResume = cmd === "!resume";
    const isStop = cmd === "!stop";
    const isUpdate = cmd === "!update";
    const isStatus = cmd === "!status";

    if (!isAnnounce && !isResume && !isStop && !isUpdate && !isStatus) return;

    // Verifica permissões
    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("⛔ Requer permissão de **Administrador**");
    }

    const guildId = message.guild.id;
    const state = stateManager.state;

    // Inicializa guildData (inclui blockedDMs na inicialização)
    if (!state.guildData[guildId]) {
        await stateManager.modify(s => {
            s.guildData[guildId] = {
                lastAnnounceTime: 0,
                totalSuccess: 0,
                totalFail: 0,
                totalClosed: 0,
                failedQueue: [],
                pendingQueue: [],
                lastRunText: "",
                lastRunAttachments: [],
                processedMembers: new Set(),
                blockedDMs: new Set() // NOVO: Set para DMs permanentemente fechadas
            };
        });
    }

    const gd = state.guildData[guildId];

    // === !STATUS ===
    if (isStatus) {
        const isActive = state.active && state.currentAnnounceGuildId === guildId;
        const embed = new EmbedBuilder()
            .setTitle("📊 Status do Sistema")
            .setColor(isActive ? 0x00FF00 : 0x808080)
            .addFields(
                { name: "Estado", value: isActive ? "🟢 Ativo" : "⚪ Parado", inline: true },
                { name: "Pendentes", value: `${gd.pendingQueue.length}`, inline: true },
                { name: "Falhas", value: `${gd.failedQueue.length}`, inline: true },
                { name: "Bloqueados", value: `${gd.blockedDMs.size}`, inline: true } // NOVO
            );

        if (isActive) {
            embed.addFields(
                { name: "✅ Enviadas", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Erros", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 Fechadas", value: `${state.currentRunStats.closed}`, inline: true }
            );
        }

        const cooldownInfo = calculateCooldownInfo(gd);
        if (cooldownInfo) {
            embed.addFields({ name: "⏰ Cooldown", value: cooldownInfo, inline: false });
        }

        return message.reply({ embeds: [embed] });
    }

    // === !STOP ===
    if (isStop) {
        if (!state.active || state.currentAnnounceGuildId !== guildId) {
            return message.reply("⚠️ Nenhum envio ativo neste servidor");
        }
        
        await stateManager.modify(s => s.active = false);
        return message.reply("⏸️ Envio pausado. Use `!resume` para continuar");
    }

    // === !UPDATE ===
    if (isUpdate) {
        if (!gd.lastRunText && gd.lastRunAttachments.length === 0) {
            return message.reply("❌ Nenhuma campanha anterior encontrada. Use `!announce` primeiro");
        }

        const members = await getCachedMembers(message.guild);
        const newIds = [];

        members.forEach(m => {
            // Filtra bots, membros já processados E DMs permanentemente bloqueadas
            if (!m.user.bot && !gd.processedMembers.has(m.id) && !gd.blockedDMs.has(m.id)) {
                newIds.push(m.id);
            }
        });

        if (newIds.length === 0) {
            return message.reply("✅ Nenhum membro novo para adicionar");
        }

        const isActive = state.active && state.currentAnnounceGuildId === guildId;

        await stateManager.modify(s => {
            // Adiciona IDs à fila apropriada
            if (isActive) {
                s.queue.push(...newIds);
            } else {
                s.guildData[guildId].pendingQueue.push(...newIds);
            }
            
            // Marca como processados
            newIds.forEach(id => s.guildData[guildId].processedMembers.add(id));
        });

        const targetQueue = isActive ? "ativa" : "pendente";
        return message.reply(`➕ Adicionados **${newIds.length}** novos membros à fila ${targetQueue}`);
    }

    // === !RESUME ===
    if (isResume) {
        if (state.active) {
            return message.reply("⚠️ Já existe um envio ativo globalmente");
        }

        let stateToLoad = null;
        let resumeSource = "local";

        // Tenta ler anexo JSON para retomar
        if (message.attachments.size > 0) {
            const jsonResult = await readAttachmentJSON(message);
            if (!jsonResult.success) {
                return message.reply(jsonResult.error);
            }
            
            // NOVO: Validação de Guild (Ponto 1)
            if (jsonResult.state.currentAnnounceGuildId !== guildId) {
                return message.reply("❌ O arquivo de estado anexado pertence a um servidor diferente. Use-o no servidor onde a campanha foi iniciada.");
            }
            
            stateToLoad = jsonResult.state;
            resumeSource = "anexo";
        }
        
        // Se houver anexo, o stateManager.state será substituído. Se não, usa o estado atual (local).
        if (stateToLoad) {
            const tempState = stateManager.load(stateToLoad);
            if (!tempState) return message.reply("❌ Não foi possível carregar o estado do arquivo JSON.");
            // Troca o estado atual pelo estado do anexo (mantendo a fila de save)
            await stateManager.modify(s => Object.assign(s, tempState));
        }
        
        // Recarrega o estado modificado
        const currentState = stateManager.state;
        const currentGd = currentState.guildData[guildId];

        // Junta pendentes e falhas (remove duplicatas) E exclui Bloqueados
        const allIds = [...new Set([...currentGd.pendingQueue, ...currentGd.failedQueue])]
            .filter(id => !currentGd.blockedDMs.has(id)); // NOVO: Filtra IDs permanentemente bloqueados
        
        if (allIds.length === 0) {
            return message.reply(`✅ Nenhum membro para retomar (${resumeSource})`);
        }

        // Valida que há dados para enviar
        if (!currentGd.lastRunText && (!currentGd.lastRunAttachments || currentGd.lastRunAttachments.length === 0)) {
            return message.reply("❌ Dados da campanha anterior perdidos. Use `!announce` para criar nova campanha");
        }

        await stateManager.modify(s => {
            s.active = true;
            s.currentAnnounceGuildId = guildId;
            s.text = currentGd.lastRunText || "";
            s.attachments = currentGd.lastRunAttachments || [];
            s.queue = allIds;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            
            // Limpa filas pois foram movidas para queue
            s.guildData[guildId].pendingQueue = [];
            s.guildData[guildId].failedQueue = [];
        });

        const progressMsg = await message.reply(`🔄 Retomando envio (${resumeSource}) para **${allIds.length}** membros...`);
        
        await stateManager.modify(s => {
            s.progressMessageRef = {
                channelId: progressMsg.channel.id,
                messageId: progressMsg.id
            };
        });

        startProgressUpdater();
        startWorker();
        return;
    }

    // === !ANNOUNCE ===
    if (isAnnounce) {
        // Verifica se já há envio ativo globalmente
        if (state.active) {
            return message.reply("❌ Já existe um envio ativo globalmente. Aguarde sua conclusão ou use `!stop`");
        }

        // Parse do comando
        const parsed = parseSelectors(message.content.slice(cmd.length).trim());
        const text = parsed.cleaned;
        const attachments = [...message.attachments.values()];

        // Valida conteúdo
        if (!text && attachments.length === 0) {
            return message.reply("❌ É necessário enviar **texto** ou **anexo**");
        }

        // Valida anexos
        if (attachments.length > 0) {
            const validation = validateAttachments(attachments);
            if (!validation.valid) {
                return message.reply(validation.error);
            }
        }

        // Verifica se há pendentes/falhas e se precisa de confirmação
        const pendingCount = gd.pendingQueue?.length || 0;
        const failedCount = gd.failedQueue?.length || 0;
        const totalRemaining = pendingCount + failedCount;

        if (totalRemaining > 0 && !parsed.hasForce) {
            const forceCmd = cmd.includes("for") 
                ? `!announcefor force ${parsed.cleaned}` 
                : `!announce force ${parsed.cleaned}`;
            
            return message.reply(
                `⚠️ **Atenção!** Há **${totalRemaining}** membros de envio anterior (${pendingCount} pendentes + ${failedCount} falhas).\n\n` +
                `• Para **continuar** de onde parou: \`!resume\`\n` +
                `• Para **descartar** e iniciar nova campanha: \`${forceCmd}\``
            );
        }

        // VERIFICA COOLDOWN (apenas para novos anúncios)
        const now = Date.now();
        const lastCampaignSize = gd.totalSuccess + gd.totalClosed + gd.totalFail;
        
        let requiredCooldown = GUILD_COOLDOWN_MIN_MS;
        if (lastCampaignSize > 0) {
            requiredCooldown = Math.max(
                GUILD_COOLDOWN_MIN_MS,
                lastCampaignSize * COOLDOWN_PENALTY_MS_PER_USER
            );
        }

        if (gd.lastAnnounceTime && (now - gd.lastAnnounceTime) < requiredCooldown) {
            const remainingMs = requiredCooldown - (now - gd.lastAnnounceTime);
            const remainingHours = Math.floor(remainingMs / 3600000);
            const remainingMinutes = Math.ceil((remainingMs % 3600000) / 60000);
            
            let timeDisplay = "";
            if (remainingHours > 0) timeDisplay += `${remainingHours}h `;
            if (remainingMinutes > 0) timeDisplay += `${remainingMinutes}min`;
            
            const cooldownHours = (requiredCooldown / 3600000).toFixed(1);
            
            return message.reply(
                `⏰ **Cooldown ativo**\n\n` +
                `O último envio de **${lastCampaignSize} DMs** requer descanso de **${cooldownHours}h**.\n` +
                `Tempo restante: **${timeDisplay.trim()}**`
            );
        }

        // Limpa filas se usou 'force'
        if (totalRemaining > 0 && parsed.hasForce) {
            await stateManager.modify(s => {
                s.guildData[guildId].pendingQueue = [];
                s.guildData[guildId].failedQueue = [];
            });
            await message.reply(`🗑️ Fila anterior de **${totalRemaining}** membros descartada`);
        }

        // Busca membros
        const members = await getCachedMembers(message.guild);
        const queue = [];
        const processedSet = new Set();
        const mode = cmd.includes("for") ? "for" : "announce";

        members.forEach(m => {
            if (m.user.bot) return;
            
            // Filtros
            if (mode === "for" && !parsed.only.has(m.id)) return;
            if (mode === "announce" && parsed.ignore.has(m.id)) return;
            // NOVO: Filtra membros permanentemente bloqueados
            if (gd.blockedDMs.has(m.id)) return;
            
            queue.push(m.id);
            processedSet.add(m.id);
        });

        if (queue.length === 0) {
            return message.reply("❌ Nenhum membro encontrado após aplicar filtros");
        }

        // Prepara anexos no formato correto
        const formattedAttachments = attachments.map(a => a.url);

        // Inicia campanha
        await stateManager.modify(s => {
            s.active = true;
            s.currentAnnounceGuildId = guildId;
            s.text = text;
            s.attachments = formattedAttachments;
            s.queue = queue;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            s.ignore = parsed.ignore;
            s.only = parsed.only;
            
            // Salva para possíveis !resume
            s.guildData[guildId].lastRunText = text;
            s.guildData[guildId].lastRunAttachments = formattedAttachments;
            s.guildData[guildId].processedMembers = processedSet;
        });

        const progressMsg = await message.reply(`🚀 Iniciando envio para **${queue.length}** membros...`);
        
        await stateManager.modify(s => {
            s.progressMessageRef = {
                channelId: progressMsg.channel.id,
                messageId: progressMsg.id
            };
        });

        startProgressUpdater();
        startWorker();
    }
});

// ===== FUNÇÕES AUXILIARES =====
function calculateCooldownInfo(guildData) {
    if (!guildData.lastAnnounceTime) return null;
    
    const now = Date.now();
    const lastSize = guildData.totalSuccess + guildData.totalClosed + guildData.totalFail;
    
    if (lastSize === 0) return null;
    
    const requiredCooldown = Math.max(
        GUILD_COOLDOWN_MIN_MS,
        lastSize * COOLDOWN_PENALTY_MS_PER_USER
    );
    
    const elapsed = now - guildData.lastAnnounceTime;
    
    if (elapsed >= requiredCooldown) {
        return "✅ Disponível";
    }
    
    const remaining = requiredCooldown - elapsed;
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.ceil((remaining % 3600000) / 60000);
    
    let display = "";
    if (hours > 0) display += `${hours}h `;
    if (minutes > 0) display += `${minutes}min`;
    
    return `⏳ ${display.trim()} restantes`;
}

// ===== AUTO-RESUME =====
client.on("ready", async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    
    const state = stateManager.state;
    
    // Tenta recuperar mensagem de progresso
    if (state.progressMessageRef) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (ch) {
                progressMessageRuntime = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
            }
        } catch (e) {
            console.warn("⚠️ Não foi possível recuperar mensagem de progresso");
        }
    }
    
    // Auto-resume se houver fila ativa
    if (state.active && state.queue.length > 0) {
        console.log(`🔄 Retomando envio de ${state.queue.length} membros...`);
        startProgressUpdater();
        startWorker();
    } else if (state.active && state.queue.length === 0) {
        // Estado inconsistente - limpa
        console.warn("⚠️ Estado ativo mas fila vazia - Limpando estado");
        await stateManager.modify(s => {
            s.active = false;
            s.currentAnnounceGuildId = null;
        });
        stateManager.forceSave();
    }
});

// ===== ERROR HANDLERS =====
process.on("unhandledRejection", (err) => {
    console.error("❌ Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    stateManager.forceSave();
    process.exit(1);
});

client.on("error", (err) => {
    console.error("❌ Client Error:", err);
});

// ===== LOGIN =====
if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não encontrado no .env");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("❌ Falha no login:", err);
    process.exit(1);
});