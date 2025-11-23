require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const nodemailer = require("nodemailer");
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================================
// 🧠 CONFIGURAÇÃO DA INTELIGÊNCIA ARTIFICIAL (GEMINI)
// ============================================================================

const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) 
    : null;

// Utiliza o modelo Flash 2.5 para velocidade e economia, ou null se sem chave
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;

// ============================================================================
// 🌍 DETECÇÃO DE AMBIENTE (LOCAL vs NUVEM)
// ============================================================================

// Verifica variáveis típicas de nuvem (Heroku, Railway, Render, etc.)
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;

console.log(`🌍 Ambiente Detectado: ${IS_LOCAL ? 'LOCAL (PC - Testes Rápidos)' : 'NUVEM (Produção - Stealth Ativo)'}`);

// ============================================================================
// ⚙️ CONFIGURAÇÕES GERAIS E CONSTANTES DE SEGURANÇA
// ============================================================================

const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

let currentDelayBase = 22000;
let currentBatchBase = 14;

// NOVOS VALORES AGRESSIVOS MAS SEGUROS
const DELAY_RANDOM_MS = 22000;        // +0 a +22s → média final 16–28s
const BATCH_VARIANCE = 8;             // agora 6–22 mensagens por lote (mais natural)
const MIN_BATCH_PAUSE_MS = 9  * 60 * 1000;  // 9 minutos
const MAX_BATCH_PAUSE_MS = 18 * 60 * 1000;  // 18 minutos

// Delay extra longo (imita pessoa que parou pra pensar/ler)
const EXTRA_LONG_DELAY_CHANCE = 0.18;  // 18% das mensagens
const EXTRA_LONG_DELAY_MS     = 35000; // +35s base (produção)

// === FILTROS DE QUALIDADE DE CONTA ===
const MIN_ACCOUNT_AGE_DAYS = 30; // Ignora contas novas (frequentemente iscas)
const IGNORE_NO_AVATAR = true;   // Ignora usuários sem foto (frequentemente bots/spam traps)

// === SISTEMA DE COOLDOWN DINÂMICO ===
const GUILD_COOLDOWN_MIN_HOURS = 6;
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 2000; // +2s de cooldown por usuário atingido

// === PROTEÇÃO CONTRA SOFT-BAN ===
const SAVE_THRESHOLD = 5; 
const MEMBER_CACHE_TTL = 5 * 60 * 1000; 
const SOFT_BAN_THRESHOLD = 0.4; // 40% de erro ativa emergência
const SOFT_BAN_MIN_SAMPLES = 10; 

// ============================================================================
// 📧 SERVIÇO DE E-MAIL DE EMERGÊNCIA
// ============================================================================

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    }
});

/**
 * Envia backup de emergência por e-mail caso o bot pare ou detecte risco.
 */
async function sendBackupEmail(reason, state) {
    console.log(`📧 Iniciando backup por e-mail. Motivo: ${reason}`);
    
    const guildId = state.currentAnnounceGuildId;
    let remainingUsers = [...state.queue];
    
    // Coleta todos os usuários pendentes de todas as listas
    if (guildId && state.guildData[guildId]) {
        const gd = state.guildData[guildId];
        const allPending = [
            ...state.queue,
            ...gd.pendingQueue,
            ...gd.failedQueue
        ];
        // Filtra duplicados e bloqueados
        remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
    }

    if (remainingUsers.length === 0) {
        console.log("ℹ️ Backup ignorado: Fila vazia.");
        return;
    }

    const backupData = {
        source: "Bot_Stealth_System_V2_Hybrid",
        timestamp: Date.now(),
        reason: reason,
        text: state.text || (guildId ? state.guildData[guildId]?.lastRunText : ""),
        attachments: state.attachments || (guildId ? state.guildData[guildId]?.lastRunAttachments : []),
        currentAnnounceGuildId: guildId,
        remainingQueue: remainingUsers
    };

    const jsonContent = JSON.stringify(backupData, null, 2);

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: TARGET_EMAIL,
        subject: `🚨 Bot Alert: ${reason}`,
        text: `O sistema parou para proteção.\nMotivo: ${reason}\nRestantes: ${remainingUsers.length}\n\nUse !resume com o anexo para continuar.`,
        attachments: [{ filename: `resume_${Date.now()}.json`, content: jsonContent }]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("✅ E-mail de backup enviado.");
    } catch (error) {
        console.error("❌ Falha no envio de e-mail:", error);
    }
}

// ============================================================================
// 💾 GERENCIADOR DE ESTADO (PERSISTÊNCIA)
// ============================================================================

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

            // Recupera Sets
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // Inicializa dados das Guildas (Garante Arrays)
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = Array.isArray(gd.processedMembers) ? gd.processedMembers : [];
                gd.blockedDMs = Array.isArray(gd.blockedDMs) ? gd.blockedDMs : []; 
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
                gd.lastRunText = gd.lastRunText || "";
                gd.lastRunAttachments = Array.isArray(gd.lastRunAttachments) ? gd.lastRunAttachments : [];
            }
            return loaded;
        } catch (e) {
            if (initialState) return null;
            console.log("ℹ️ Iniciando com estado limpo.");
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
                    blockedDMs: [...data.blockedDMs] 
                };
            }
            fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
            this.unsavedChanges = 0;
        } catch (e) { console.error("Erro ao salvar:", e); }
    }

    async modify(callback) {
        return this.saveQueue = this.saveQueue.then(async () => {
            callback(this.state);
            this.unsavedChanges++;
            if (this.unsavedChanges >= SAVE_THRESHOLD) this.save();
        });
    }

    forceSave() {
        if (this.unsavedChanges > 0) this.save();
    }

    setupShutdownHandler() {
        const saveOnExit = async (signal) => {
            console.log(`\n🛑 Encerrando (${signal})...`);
            this.forceSave();
            const hasActiveQueue = this.state.active && this.state.queue.length > 0;
            if (hasActiveQueue) await sendBackupEmail(`Shutdown (${signal})`, this.state);
            process.exit(0);
        };
        process.on('SIGINT', () => saveOnExit('SIGINT'));
        process.on('SIGTERM', () => saveOnExit('SIGTERM'));
    }
}

const stateManager = new StateManager(STATE_FILE);

// ============================================================================
// 🤖 CLIENTE DISCORD & CACHE
// ============================================================================

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

// ============================================================================
// 🛠️ UTILITÁRIOS & FERRAMENTAS
// ============================================================================

const wait = ms => new Promise(r => setTimeout(r, ms));

function randomizeParameters() {
    if (IS_LOCAL) {
        currentDelayBase = 2000 + Math.random() * 3000;
        currentBatchBase = 10 + Math.floor(Math.random() * 8);
        console.log(`LOCAL → Delay ~${(currentDelayBase/1000).toFixed(1)}s | Lote ~${currentBatchBase}`);
        return;
    }

    // PRODUÇÃO 2025 — AGRESSIVO MAS INDETECTÁVEL
    currentDelayBase = 16000 + Math.floor(Math.random() * 12000);  // 16–28s
    currentBatchBase = 14   + Math.floor(Math.random() * 9);       // 14–22 msgs

    console.log(`STEALTH AGRESSIVO → Delay ${(currentDelayBase/1000).toFixed(1)}–${((currentDelayBase + DELAY_RANDOM_MS)/1000).toFixed(1)}s | Lote ${currentBatchBase} ±${BATCH_VARIANCE}`);
}

function getNextBatchSize() {
    const min = Math.max(1, currentBatchBase - BATCH_VARIANCE);
    const max = currentBatchBase + BATCH_VARIANCE;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateTypingTime(text) {
    if (!text) return 1500;
    const ms = (text.length / 15) * 1000;
    return Math.min(9000, Math.max(2500, ms));
}

function isSuspiciousAccount(user) {
    const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (ageInDays < MIN_ACCOUNT_AGE_DAYS) return true;
    if (IGNORE_NO_AVATAR && !user.avatar) return true;
    return false;
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
    return { cleaned: hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned, ignore, only, hasForce };
}

function validateAttachments(attachments) {
    const MAX_SIZE = 8 * 1024 * 1024; 
    const ALLOWED = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.pdf', '.webm'];
    for (const att of attachments) {
        if (att.size > MAX_SIZE) return { valid: false, error: `❌ Arquivo > 8MB` };
        const ext = path.extname(att.name).toLowerCase();
        if (!ALLOWED.includes(ext)) return { valid: false, error: `❌ Tipo inválido: ${ext}` };
    }
    return { valid: true };
}

async function getCachedMembers(guild) {
    const cached = memberCache.get(guild.id);
    if (cached && Date.now() - cached.timestamp < MEMBER_CACHE_TTL) return cached.members;
    try { await guild.members.fetch(); } catch (e) {}
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

function detectSoftBan(stats) {
    const total = stats.success + stats.fail + stats.closed;
    if (total < SOFT_BAN_MIN_SAMPLES) return false;
    return ((stats.closed + stats.fail) / total) >= SOFT_BAN_THRESHOLD;
}

async function readAttachmentJSON(url) {
    if (!url || (!url.endsWith('.json') && !url.endsWith('.txt'))) {
        return { success: false, error: "❌ URL inválida ou não é JSON" };
    }
    return new Promise(resolve => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, state: parsed });
                } catch (e) {
                    resolve({ success: false, error: "❌ JSON Corrompido." });
                }
            });
        }).on('error', (err) => resolve({ success: false, error: err.message }));
    });
}

// ============================================================================
// 🧠 PROCESSAMENTO DE IA (VARIAÇÃO E STEALTH)
// ============================================================================

async function getAiVariation(originalText, globalname) {
    if (!model || !originalText || originalText.length < 3) return originalText;
    try {
        const prompt = `
        Aja como um assistente de comunicação minimalista e eficiente. Reescreva a mensagem abaixo para a pessoa chamada "${globalname}".
        
        Regras:
        1. Mantenha EXATAMENTE o mesmo significado e intenção da "Mensagem Original".
        2. Se houver links (http...), MANTENHA-OS IDÊNTICOS.
        3. Mantenha o texto de saída no **mesmo idioma** da "Mensagem Original".
        4. **CRÍTICO:** Sua única função é fazer uma alteração pontual: **Troque APENAS UMA ÚNICA PALAVRA ou a saudação inicial por um sinônimo**. Mantenha o restante da frase (incluindo pontuação e estrutura) idêntico ao original.
        5. NÃO use aspas na resposta. Apenas o texto puro.

        Mensagem Original: "${originalText}"
        `;
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        
        if (!text || text.trim().length === 0) {
            console.warn("⚠️ IA retornou vazio. Usando original.");
            return originalText;
        }
        return text.replace(/^"|"$/g, '').trim();
    } catch (error) {
        console.warn(`⚠️ Erro IA (Fallback Original): ${error.message}`);
        return originalText;
    }
}

// ============================================================================
// 📨 FUNÇÃO DE ENVIO (SINGLE PAYLOAD - MAIS SEGURO)
// ============================================================================

async function sendStealthDM(user, rawText, attachments) {
    let dmChannel;
    try {
        if (user.dmChannel) dmChannel = user.dmChannel;
        else dmChannel = await user.createDM();
    } catch (e) { return { success: false, reason: "closed" }; }

    // 1. Gera Variação
    let finalContent = rawText;
    if (rawText) {
        const userDisplay = user.globalName || user.username || "amigo";
        finalContent = await getAiVariation(rawText, userDisplay);
    }

    // 2. Comportamento Humano
    try {
        const shouldType = Math.random() > 0.25;
        if (shouldType && finalContent) {
            await dmChannel.sendTyping();
            const typeTime = calculateTypingTime(finalContent); 
            await wait(typeTime);
        } else {
            await wait(Math.floor(Math.random() * 2000) + 1000);
        }
    } catch (e) { /* Ignora */ }

    // 3. Monta Payload Único
    const payload = {};
    if (finalContent) payload.content = finalContent;
    if (attachments && attachments.length > 0) payload.files = attachments;

    if (!payload.content && !payload.files) return { success: false, reason: "empty" };

    // 4. Envio com Retry
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await dmChannel.send(payload);
            console.log(`✅ Enviado ${user.tag}: "${finalContent ? finalContent.substring(0, 20) : 'IMG'}..."`);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            const code = err.code || 0;

            // ERROS CRÍTICOS (SPAM/BLOCK)
            if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                 console.error("🚨 ALERTA CRÍTICO: SPAM FLAG (40003)");
                 await stateManager.modify(s => s.quarantine = true);
                 return { success: false, reason: "quarantine" };
            }
            
            if (code === 50007 || code === 50001) {
                return { success: false, reason: "closed" };
            }

            // RATE LIMIT (ESPERA)
            if (err.retry_after || code === 20016) {
                const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;
                console.warn(`⏳ Rate Limit. Esperando ${waitTime/1000}s.`);
                currentDelayBase += 5000;
                await wait(waitTime);
                continue;
            }
            
            // ERRO DE REDE (BACKOFF)
            const backoff = 5000 * attempt;
            console.error(`❌ Erro envio (${attempt}): ${errMsg}. Esperando ${backoff}ms.`);
            if (attempt < RETRY_LIMIT) await wait(backoff);
        }
    }
    return { success: false, reason: "fail" };
}

// ============================================================================
// 🏭 WORKER LOOP (O MOTOR DO BOT)
// ============================================================================

async function workerLoop() {
    console.log("🚀 Worker Iniciado");
    const state = stateManager.state;
    const guildId = state.currentAnnounceGuildId;
    const gd = state.guildData[guildId] || {};

    try {
        let sentInBatch = 0;
        let currentBatchSize = getNextBatchSize();

        while (state.active && state.queue.length > 0) {
            
            // Lógica de Pausa de Lotes
            if (sentInBatch >= currentBatchSize) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                // Se for LOCAL, pausa rápida (3s), se NUVEM, pausa stealth
                const pauseDuration = IS_LOCAL 
                    ? 3000 
                    : MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * (MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS));

                console.log(`Lote concluído. Pausa de ${(pauseDuration/60000).toFixed(1)} minutos.`);
                
                console.log(`⏸️ Lote fim. Pausa ${(pauseDuration/1000).toFixed(0)}s.`);
                
                stateManager.forceSave();
                await updateProgressEmbed();
                
                await wait(pauseDuration);
                randomizeParameters();
                
                // Verifica se foi parado durante a pausa
                if (!stateManager.state.active || stateManager.state.queue.length === 0) break;
                
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
            }

            const userId = state.queue.shift();
            await stateManager.modify(() => {}); 

            // Filtro: Lista Negra Local
            if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                console.log(`⏭️ Bloqueado: ${userId}`);
                continue;
            }

            // Busca Usuário (Cache -> API)
            let user = client.users.cache.get(userId);
            if (!user) {
                try { user = await client.users.fetch(userId); } 
                catch (e) {
                    console.log(`⏭️ Inacessível: ${userId}`);
                    await stateManager.modify(s => {
                         if (!s.guildData[guildId].processedMembers.includes(userId)) s.guildData[guildId].processedMembers.push(userId);
                    });
                    continue;
                }
            }
            
            // Filtro: Bot ou Conta Suspeita
            if (user.bot || isSuspiciousAccount(user)) {
                console.log(`🚫 Ignorado (Bot/Suspeito): ${user.tag}`);
                continue;
            }

            // ENVIO
            const result = await sendStealthDM(user, state.text, state.attachments);

            // Atualização de Estatísticas
            await stateManager.modify(s => {
                const gData = s.guildData[guildId];
                if (result.success) {
                    s.currentRunStats.success++;
                    const idx = gData.failedQueue.indexOf(userId);
                    if (idx > -1) gData.failedQueue.splice(idx, 1);
                } else {
                    if (result.reason === "closed") {
                        s.currentRunStats.closed++;
                        if (!gData.blockedDMs.includes(userId)) gData.blockedDMs.push(userId);
                    } else if (result.reason === "quarantine") {
                        s.active = false;
                    } else {
                        s.currentRunStats.fail++;
                        if (!gData.failedQueue.includes(userId)) gData.failedQueue.push(userId);
                    }
                }
                if (!gData.processedMembers.includes(userId)) gData.processedMembers.push(userId);
            });

            // Checagem de Emergência
            if (stateManager.state.quarantine) {
                await sendBackupEmail("Quarentena Detectada (API Flag)", stateManager.state);
                break;
            }

            if (detectSoftBan(state.currentRunStats)) {
                console.error("🚨 SOFT-BAN DETECTADO.");
                await stateManager.modify(s => {
                    s.quarantine = true;
                    s.active = false;
                });
                await sendBackupEmail("Soft-Ban (Alta taxa de rejeição)", stateManager.state);
                break;
            }

            updateProgressEmbed().catch(() => {});
            
            // Delay pós-envio
            if (result.success) {
                let d = currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS);

                // 18% das vezes simula "pessoa pensando / distraída" → ultra humano
                if (Math.random() < EXTRA_LONG_DELAY_CHANCE) {
                    const extra = IS_LOCAL ? 5000 : EXTRA_LONG_DELAY_MS + Math.floor(Math.random() * 25000);
                    d += extra;
                    console.log(`Pensando na vida... +${(extra/1000).toFixed(0)}s extra`);
                }

                await wait(d);
            } else {
                const penalty = result.reason === "closed"
                    ? (IS_LOCAL ? 1000 : 5000)
                    : (IS_LOCAL ? 2000 : 20000);
                await wait(penalty);
            }
            sentInBatch++;
        }

        // Finalização
        if (state.queue.length === 0 && state.active) {
            console.log("✅ Fim da Fila.");
            await finalizeSending();
        }

    } catch (err) {
        console.error("💥 Erro Crítico no Worker:", err);
        stateManager.forceSave();
        await sendBackupEmail(`Erro Crítico no Worker: ${err.message}`, stateManager.state);
    } finally {
        workerRunning = false;
        const finalState = stateManager.state;
        if (finalState.queue.length > 0 && (!finalState.active || finalState.quarantine)) {
            console.log("⚠️ Worker interrompido.");
            await finalizeSending();
        }
    }
}

function startWorker() {
    if (workerRunning) return;
    workerRunning = true;
    workerLoop().catch(err => { console.error("Worker Crash:", err); workerRunning = false; stateManager.forceSave(); });
}

async function finalizeSending() {
    const state = stateManager.state;
    stopProgressUpdater();
    const guildId = state.currentAnnounceGuildId;
    
    await stateManager.modify(s => {
        if (guildId && s.queue.length > 0) s.guildData[guildId].pendingQueue.push(...s.queue);
        s.queue = [];
        s.active = false;
    });
    stateManager.forceSave();

    const stats = state.currentRunStats;
    const remaining = (state.guildData[guildId]?.pendingQueue.length || 0);
    const embedColor = remaining === 0 && !state.quarantine ? 0x00FF00 : 0xFF0000;
    
    const embed = new EmbedBuilder()
        .setTitle("📬 Relatório Final")
        .setColor(embedColor)
        .addFields(
            { name: "✅ Sucesso", value: `${stats.success}`, inline: true },
            { name: "❌ Falhas", value: `${stats.fail}`, inline: true },
            { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
        );

    if (state.quarantine) {
        embed.addFields({
            name: "🚨 STATUS: QUARENTENA/INTERROMPIDO",
            value: "O bot interrompeu o envio para proteção. **Backup enviado.**",
            inline: false
        });
    }

    const finalText = remaining === 0 ? "✅ Campanha finalizada!" : `⏸️ Parado. Restam ${remaining} membros.`;

    if (state.progressMessageRef) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId);
            const msg = await ch.messages.fetch(state.progressMessageRef.messageId);
            await msg.edit({ content: finalText, embeds: [embed] }).catch(async () => {
                await ch.send({ content: finalText, embeds: [embed] });
            });
        } catch (e) {}
    }

    await stateManager.modify(s => s.currentAnnounceGuildId = null);
    stateManager.forceSave();
}

async function updateProgressEmbed() {
    const state = stateManager.state;
    if (!state.progressMessageRef) return;
    try {
        const ch = await client.channels.fetch(state.progressMessageRef.channelId);
        const msg = await ch.messages.fetch(state.progressMessageRef.messageId);
        const embed = new EmbedBuilder()
            .setTitle("📨 Enviando...")
            .setColor("#00AEEF")
            .setDescription(`Fila: ${state.queue.length} | Sucesso: ${state.currentRunStats.success}`);
        await msg.edit({ embeds: [embed] });
    } catch (e) {}
}

function startProgressUpdater() {
    if (progressUpdaterHandle) return;
    progressUpdaterHandle = setInterval(() => { if (stateManager.state.active) updateProgressEmbed(); }, 5000);
}

function stopProgressUpdater() {
    if (progressUpdaterHandle) { clearInterval(progressUpdaterHandle); progressUpdaterHandle = null; }
}

function calculateCooldownInfo(guildData) {
    if (!guildData.lastAnnounceTime) return null;
    const now = Date.now();
    const lastSize = guildData.totalSuccess + guildData.totalClosed + guildData.totalFail;
    if (lastSize === 0) return null;
    const requiredCooldown = Math.max(GUILD_COOLDOWN_MIN_MS, lastSize * COOLDOWN_PENALTY_MS_PER_USER);
    const elapsed = now - guildData.lastAnnounceTime;
    if (elapsed >= requiredCooldown) return "✅ Disponível";
    return `⏳ ${(requiredCooldown - elapsed)/60000}m restantes`;
}

// ============================================================================
// 🎮 LÓGICA CENTRAL DOS COMANDOS (AGNOSTICA À ENTRADA)
// ============================================================================

// Função auxiliar para responder (Privado se Slash, Público se Msg)
async function unifiedReply(ctx, content, embeds = []) {
    const payload = { content, embeds };
    if (ctx.isChatInputCommand?.()) { 
        payload.ephemeral = true; // Resposta invisível no Slash (Sua solicitação)
        if (ctx.deferred || ctx.replied) return ctx.editReply(payload);
        return ctx.reply(payload);
    }
    return ctx.reply(payload);
}

// Lógica do ANNOUNCE (Serve para !announce e /announce)
async function execAnnounce(ctx, text, attachmentUrl, filtersStr) {
    const guildId = ctx.guild.id;
    const state = stateManager.state;
    const gd = state.guildData[guildId];

    if (state.active) return unifiedReply(ctx, "❌ Já existe um envio ativo.");

    const parsed = parseSelectors(filtersStr || "");
    
    if (!text && !attachmentUrl) return unifiedReply(ctx, "❌ Envie texto ou anexo.");

    const totalRemaining = gd.pendingQueue.length + gd.failedQueue.length;
    if (totalRemaining > 0 && !parsed.hasForce) {
        return unifiedReply(ctx, `⚠️ Há **${totalRemaining}** pendentes. Use \`resume\` ou adicione \`force\` nos filtros.`);
    }

    const cooldownInfo = calculateCooldownInfo(gd);
    if (!IS_LOCAL && cooldownInfo && cooldownInfo.includes("restantes")) {
        return unifiedReply(ctx, `⛔ **Cooldown Ativo:**\n${cooldownInfo}`);
    }

    if (totalRemaining > 0 && parsed.hasForce) {
        await stateManager.modify(s => {
            s.guildData[guildId].pendingQueue = [];
            s.guildData[guildId].failedQueue = [];
        });
    }

    const members = await getCachedMembers(ctx.guild);
    const queue = [];
    const processedSet = new Set();

    members.forEach(m => {
        if (m.user.bot) return;
        if (gd.blockedDMs.includes(m.id)) return;
        if (parsed.only.size > 0 && !parsed.only.has(m.id)) return;
        if (parsed.ignore.has(m.id)) return;
        queue.push(m.id);
        processedSet.add(m.id);
    });

    if (queue.length === 0) return unifiedReply(ctx, "❌ Nenhum membro encontrado.");

    const attachments = attachmentUrl ? [attachmentUrl] : [];

    await stateManager.modify(s => {
        s.active = true;
        s.quarantine = false;
        s.currentAnnounceGuildId = guildId;
        s.text = text || "";
        s.attachments = attachments;
        s.queue = queue;
        s.currentRunStats = { success: 0, fail: 0, closed: 0 };
        s.ignore = parsed.ignore;
        s.only = parsed.only;
        
        const gData = s.guildData[guildId];
        gData.lastRunText = text || "";
        gData.lastRunAttachments = attachments;
        gData.processedMembers = [...processedSet];
    });

    const msgContent = `🚀 Iniciando envio Stealth para **${queue.length}** membros...`;
    
    // Para atualizar progresso, precisamos do ID da mensagem.
    // No Slash Command, precisamos do fetchReply.
    let progressMsg;
    if (ctx.isChatInputCommand?.()) {
        await unifiedReply(ctx, msgContent);
        progressMsg = await ctx.fetchReply();
    } else {
        progressMsg = await unifiedReply(ctx, msgContent);
    }

    await stateManager.modify(s => {
        s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
    });
    
    startProgressUpdater();
    startWorker();
}

// Lógica do RESUME (Serve para !resume e /resume)
async function execResume(ctx, attachmentUrl) {
    if (stateManager.state.active) return unifiedReply(ctx, "⚠️ Já ativo.");

    let stateToLoad = null;
    let resumeSource = "local";

    if (attachmentUrl) {
        const jsonResult = await readAttachmentJSON(attachmentUrl);
        if (!jsonResult.success) return unifiedReply(ctx, jsonResult.error);
        if (jsonResult.state.currentAnnounceGuildId !== ctx.guild.id) return unifiedReply(ctx, "❌ JSON de outro servidor.");
        stateToLoad = jsonResult.state;
        resumeSource = "anexo";
    }

    if (stateToLoad) {
        const tempState = stateManager.load(stateToLoad);
        if (!tempState) return unifiedReply(ctx, "❌ Erro ao carregar arquivo.");
        await stateManager.modify(s => Object.assign(s, tempState));
    }

    const s = stateManager.state;
    const gd = s.guildData[ctx.guild.id];
    
    // CORREÇÃO: Soma todas as filas (JSON + Pendente + Falha)
    const allIds = [...new Set([
        ...s.queue, 
        ...gd.pendingQueue, 
        ...gd.failedQueue
    ])].filter(id => !gd.blockedDMs.includes(id));

    if (allIds.length === 0) return unifiedReply(ctx, "✅ Ninguém para enviar.");

    const textToSend = s.text || gd.lastRunText;
    const attachToSend = (s.attachments && s.attachments.length > 0) ? s.attachments : gd.lastRunAttachments;

    if (!textToSend && (!attachToSend || attachToSend.length === 0)) {
        return unifiedReply(ctx, "❌ Dados perdidos/vazios.");
    }

    await stateManager.modify(st => {
        st.active = true;
        st.quarantine = false;
        st.currentAnnounceGuildId = ctx.guild.id;
        st.queue = allIds;
        st.text = textToSend;
        st.attachments = attachToSend || [];
        st.currentRunStats = { success: 0, fail: 0, closed: 0 };
        st.guildData[ctx.guild.id].pendingQueue = [];
        st.guildData[ctx.guild.id].failedQueue = [];
    });

    const msgContent = `🔄 Retomando envio (${resumeSource}) para **${allIds.length}** membros...`;
    let progressMsg;
    
    if (ctx.isChatInputCommand?.()) {
        await unifiedReply(ctx, msgContent);
        progressMsg = await ctx.fetchReply();
    } else {
        progressMsg = await unifiedReply(ctx, msgContent);
    }

    await stateManager.modify(st => {
        st.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
    });
    startProgressUpdater();
    startWorker();
}

// Lógica do STOP
async function execStop(ctx) {
    await stateManager.modify(s => s.active = false);
    await sendBackupEmail("Stop Manual", stateManager.state);
    unifiedReply(ctx, "🛑 Parado (Backup enviado).");
}

// Lógica do STATUS
async function execStatus(ctx) {
    const state = stateManager.state;
    const gd = state.guildData[ctx.guild.id] || {};
    const isActive = state.active && state.currentAnnounceGuildId === ctx.guild.id;
    
    const embed = new EmbedBuilder()
        .setTitle("📊 Status Stealth")
        .setColor(isActive ? 0x00FF00 : 0x808080)
        .addFields(
            { name: "Estado", value: isActive ? "🟢 Ativo" : "⚪ Parado", inline: true },
            { name: "Pendentes", value: `${gd.pendingQueue?.length || 0}`, inline: true },
            { name: "Fila Atual", value: `${state.queue.length}`, inline: true }
        );
        
    unifiedReply(ctx, "", [embed]);
}

// ============================================================================
// 📝 REGISTRO & HANDLERS DE COMANDOS
// ============================================================================

// Registra comandos "/" automaticamente ao iniciar
async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('announce')
            .setDescription('Inicia novo envio (Invisível)')
            .addStringOption(opt => opt.setName('texto').setDescription('Mensagem').setRequired(true))
            .addAttachmentOption(opt => opt.setName('anexo').setDescription('Imagem opcional'))
            .addStringOption(opt => opt.setName('filtros').setDescription('Ex: force, +{ID}')),
        new SlashCommandBuilder()
            .setName('resume')
            .setDescription('Retoma envio (Invisível)')
            .addAttachmentOption(opt => opt.setName('arquivo').setDescription('JSON Backup')),
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Para o envio (Invisível)'),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Vê status (Invisível)')
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Registrando Slash Commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash Commands Registrados!');
    } catch (e) { console.error(e); }
}

// HANDLER: SLASH (/)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "⛔ Sem permissão.", ephemeral: true });
    }

    const { commandName } = interaction;

    if (commandName === 'announce') {
        const texto = interaction.options.getString('texto');
        const anexo = interaction.options.getAttachment('anexo');
        const filtros = interaction.options.getString('filtros');
        await execAnnounce(interaction, texto, anexo ? anexo.url : null, filtros);
    } else if (commandName === 'resume') {
        const arquivo = interaction.options.getAttachment('arquivo');
        await execResume(interaction, arquivo ? arquivo.url : null);
    } else if (commandName === 'stop') {
        await execStop(interaction);
    } else if (commandName === 'status') {
        await execStatus(interaction);
    }
});

// HANDLER: MENSAGEM DE CHAT (PREFIXO !)
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;
    const content = message.content;
    if (!content.startsWith('!')) return;

    const args = content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    if (cmd === 'announce') {
        const fullContent = content.slice(9).trim();
        const attachment = message.attachments.first();
        // No prefixo, filtros e texto são a mesma string, o parseSelectors lida com isso internamente
        await execAnnounce(message, fullContent, attachment ? attachment.url : null, fullContent);
    } else if (cmd === 'resume') {
        const attachment = message.attachments.first();
        await execResume(message, attachment ? attachment.url : null);
    } else if (cmd === 'stop') {
        await execStop(message);
    } else if (cmd === 'status') {
        await execStatus(message);
    }
});

// INICIALIZAÇÃO
client.on("ready", async () => {
    console.log(`✅ Bot online como: ${client.user.tag}`);
    await registerSlashCommands();
    if (stateManager.state.active) startWorker();
});

// Captura de erros fatais para não derrubar o processo
process.on("unhandledRejection", (err) => console.error("❌ Unhandled Rejection:", err));
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    stateManager.forceSave();
    process.exit(1);
});
client.on("error", (err) => console.error("❌ Client Error:", err));
client.on('shardError', error => console.error('🔌 WebSocket Error:', error));

if (!process.env.DISCORD_TOKEN) {
    console.error("❌ Erro: DISCORD_TOKEN ausente.");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("❌ Falha no login:", err);
    process.exit(1);
});