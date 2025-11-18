require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require("discord.js");

// ===== CONFIG =====
const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;

// === SEGURANÇA ANTI-QUARENTENA ===
const DELAY_BASE_MS = 10000; // 10s base entre DMs
const DELAY_RANDOM_MS = 10000; // +0-10s aleatório
const BATCH_SIZE = 25; // Pausa a cada 25 DMs
const MIN_BATCH_PAUSE_MS = 1 * 60 * 1000; // 1 min
const MAX_BATCH_PAUSE_MS = 5 * 60 * 1000; // 5 min

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

    load() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(this.getInitialState(), parsed);

            // Converte arrays para Sets
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // Converte processedMembers e garante filas
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = new Set(Array.isArray(gd.processedMembers) ? gd.processedMembers : []);
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
                gd.lastRunText = gd.lastRunText || "";
                gd.lastRunAttachments = Array.isArray(gd.lastRunAttachments) ? gd.lastRunAttachments : [];
            }

            console.log("✅ Estado carregado com sucesso");
            return loaded;
        } catch (e) {
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
                    processedMembers: [...data.processedMembers]
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

    setupShutdownHandler() {
        const saveOnExit = () => {
            console.log("\n🛑 Encerrando - Salvando estado...");
            this.forceSave();
            process.exit(0);
        };
        process.on('SIGINT', saveOnExit);
        process.on('SIGTERM', saveOnExit);
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
            
            // DM fechada
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

    try {
        let sentInBatch = 0;

        while (state.active && state.queue.length > 0) {
            
            // === PAUSA DE LOTE ===
            if (sentInBatch >= BATCH_SIZE) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                const pauseDuration = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * pauseRange);
                const pauseMinutes = (pauseDuration / 60000).toFixed(1);
                
                console.log(`⏸️ Pausa de lote: ${sentInBatch} DMs enviadas. Pausando ~${pauseMinutes} min`);
                stateManager.forceSave();
                await updateProgressEmbed();
                await wait(pauseDuration);
                
                // Verifica se estado mudou durante pausa
                if (!stateManager.state.active || stateManager.state.queue.length === 0) {
                    console.log("⚠️ Estado alterado durante pausa - Saindo");
                    break;
                }
                
                sentInBatch = 0;
                console.log("▶️ Retomando envio");
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
                if (wasSuccess) {
                    s.currentRunStats.success++;
                    
                    // Remove da failedQueue se estava lá
                    const fq = s.guildData[guildId]?.failedQueue;
                    if (fq) {
                        const idx = fq.indexOf(userId);
                        if (idx > -1) fq.splice(idx, 1);
                    }
                } else {
                    // Registra falha
                    if (failureReason === "closed") {
                        s.currentRunStats.closed++;
                    } else {
                        s.currentRunStats.fail++;
                    }
                    
                    // Adiciona à failedQueue (sem duplicatas)
                    if (guildId && s.guildData[guildId]) {
                        const fq = s.guildData[guildId].failedQueue;
                        if (!fq.includes(userId)) {
                            fq.push(userId);
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
            await wait(DELAY_BASE_MS + Math.floor(Math.random() * DELAY_RANDOM_MS));
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
            value: "Bot foi flagado pelo sistema anti-spam. Aguarde 24 horas antes de tentar novamente.",
            inline: false
        });
    }

    const finalText = remaining === 0
        ? "✅ Campanha 100% concluída!"
        : `⏸️ Restam ${remaining} membros — Use \`!resume\` para continuar`;

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

    // Inicializa guildData
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
                processedMembers: new Set()
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
                { name: "Falhas", value: `${gd.failedQueue.length}`, inline: true }
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
            if (!m.user.bot && !gd.processedMembers.has(m.id)) {
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

        // Junta pendentes e falhas (remove duplicatas)
        const allIds = [...new Set([...gd.pendingQueue, ...gd.failedQueue])];
        
        if (allIds.length === 0) {
            return message.reply("✅ Nenhum membro para retomar");
        }

        // Valida que há dados para enviar
        if (!gd.lastRunText && (!gd.lastRunAttachments || gd.lastRunAttachments.length === 0)) {
            return message.reply("❌ Dados da campanha anterior perdidos. Use `!announce` para criar nova campanha");
        }

        await stateManager.modify(s => {
            s.active = true;
            s.currentAnnounceGuildId = guildId;
            s.text = gd.lastRunText || "";
            s.attachments = gd.lastRunAttachments || [];
            s.queue = allIds;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            
            // Limpa filas pois foram movidas para queue
            s.guildData[guildId].pendingQueue = [];
            s.guildData[guildId].failedQueue = [];
        });

        const progressMsg = await message.reply(`🔄 Retomando envio para **${allIds.length}** membros...`);
        
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