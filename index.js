require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
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
// 🔌 SERVIDOR ANTI-FREEZE (MANTÉM O RAILWAY ACORDADO)
// ============================================================================
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    const uptime = process.uptime();
    const status = {
        status: "online",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        active: stateManager?.state?.active || false,
        queue: stateManager?.state?.queue?.length || 0,
        timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
});

server.listen(PORT, () => {
    console.log(`🛡️ Escudo Anti-Freeze Ativado na porta ${PORT}`);
    console.log(`📡 Health Check disponível: http://localhost:${PORT}`);
});

// ============================================================================
// 🧠 CONFIGURAÇÃO DA INTELIGÊNCIA ARTIFICIAL (GEMINI)
// ============================================================================
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;

// ============================================================================
// 🌍 DETECÇÃO DE AMBIENTE (LOCAL vs NUVEM)
// ============================================================================
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;

console.log(`🌍 Ambiente Detectado: ${IS_LOCAL ? 'LOCAL (PC - Testes Rápidos)' : 'NUVEM (Produção - Stealth Ativo)'}`);

// ============================================================================
// ⚙️ CONFIGURAÇÕES GERAIS E CONSTANTES DE SEGURANÇA
// ============================================================================
const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// 🚀 OTIMIZAÇÃO: Delays base para início
let currentDelayBase = 12000; 
let currentBatchBase = 12;

// 🚀 OTIMIZAÇÃO: Variação menor para manter o ritmo constante
const DELAY_RANDOM_MS = 8000;
const BATCH_VARIANCE = 8;

// 🛡️ SISTEMA ANTI-QUARENTENA V2 - PAUSAS PROGRESSIVAS
const MIN_BATCH_PAUSE_MS = 3 * 60 * 1000;     // 3 min (primeira pausa)
const MAX_BATCH_PAUSE_MS = 8 * 60 * 1000;     // 8 min (pausas normais)
const EXTENDED_PAUSE_MS = 15 * 60 * 1000;     // 15 min (se taxa alta)
const MAX_ALLOWED_PAUSE_MS = 25 * 60 * 1000;  // 25 min (limite absoluto)

// 🎲 Variação de pausas aumentada para parecer mais humano
const EXTRA_LONG_DELAY_CHANCE = 0.15;  // 15% de chance
const EXTRA_LONG_DELAY_MS = 25000;     // 25s

const MIN_ACCOUNT_AGE_DAYS = 30;
const IGNORE_NO_AVATAR = true;

const GUILD_COOLDOWN_MIN_HOURS = 6;
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 2000;

const SAVE_THRESHOLD = 5;
const MEMBER_CACHE_TTL = 5 * 60 * 1000;

// 🚨 CIRCUIT BREAKER MAIS SENSÍVEL
const SOFT_BAN_THRESHOLD = 0.25; // Reduzido para 25%
const SOFT_BAN_MIN_SAMPLES = 10;
const MAX_CONSECUTIVE_CLOSED = 3;          // 3 DMs fechadas seguidas (era 8)
const CLOSED_DM_COOLING_MS = 12 * 60 * 1000; // 12 min de resfriamento (era 10)

// 🆕 MONITOR DE TAXA DE REJEIÇÃO
const REJECTION_WINDOW = 50;               // Analisa últimos 50 envios
const REJECTION_RATE_WARNING = 0.30;       // 30% = Modo Cautela
const REJECTION_RATE_CRITICAL = 0.40;      // 40% = Pausa Obrigatória

// 🆕 LIMITE DE THROUGHPUT (ANTI-SPAM)
const MAX_SENDS_PER_HOUR = 180;            // Máximo 180 envios/hora
const HOURLY_CHECK_INTERVAL = 10;          // Checa a cada 10 envios

// 🔧 NOVO: Detector de congelamento (Watchdog) e Variáveis de Controle
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 minutos sem atividade = alerta
let lastActivityTime = Date.now();

// 🆕 RASTREAMENTO DE REJEIÇÃO E THROUGHPUT (Variáveis Globais)
let recentResults = []; // Array dos últimos 50 resultados (true/false)
let sendsThisHour = 0;
let hourlyResetTime = Date.now() + 3600000; // Reseta a cada hora
let pauseMultiplier = 1.0; // Multiplicador de pausa (aumenta se muita rejeição)
let batchCounter = 0; // Contador de lotes completados

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

async function sendBackupEmail(reason, state) {
    console.log(`📧 Iniciando backup por e-mail. Motivo: ${reason}`);

    const guildId = state.currentAnnounceGuildId;
    let remainingUsers = [...state.queue];

    if (guildId && state.guildData[guildId]) {
        const gd = state.guildData[guildId];
        const allPending = [
            ...state.queue,
            ...gd.pendingQueue,
            ...gd.failedQueue
        ];
        remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
    }

    if (remainingUsers.length === 0) {
        console.log("ℹ️ Backup ignorado: Fila vazia.");
        return;
    }

    const backupData = {
        source: "Bot_Stealth_System_V2_AntiQuarantine",
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
            privacyMode: "public",
            initiatorId: null,
            guildData: {}
        };
    }

    load(initialState = null) {
        const stateToLoad = initialState || this.getInitialState();
        try {
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            if (!loaded.privacyMode) loaded.privacyMode = "public";
            if (!loaded.initiatorId) loaded.initiatorId = null;

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

let progressUpdaterHandle = null;
let workerRunning = false;
const memberCache = new Map();

// ============================================================================
// 🛠️ UTILITÁRIOS & FERRAMENTAS
// ============================================================================

// 🔧 NOVA FUNÇÃO WAIT COM HEARTBEAT (ANTI-FREEZE)
const wait = async (ms) => {
    lastActivityTime = Date.now(); // Atualiza timestamp de atividade

    // Se a pausa for curta (menos de 2 min), usa o wait normal
    if (ms < 120000) {
        return new Promise(r => setTimeout(r, ms));
    }

    // Se for longa, quebra em pedaços de 1 minuto para manter o processo vivo
    const minutes = ms / 60000;
    const steps = Math.floor(minutes);
    const remainder = ms % 60000;

    const startTime = Date.now();
    console.log(`💤 Iniciando espera segura de ${minutes.toFixed(1)} min (${new Date(startTime).toISOString()})`);

    for (let i = 0; i < steps; i++) {
        await new Promise(r => setTimeout(r, 60000)); // Espera 1 minuto
        lastActivityTime = Date.now(); // Atualiza heartbeat

        // Log a cada 3 minutos para não poluir
        if ((i + 1) % 3 === 0) {
            console.log(`⏳ ... ${i + 1}/${steps} min (${((Date.now() - startTime) / 60000).toFixed(1)}m reais)`);
        }
    }

    if (remainder > 0) {
        await new Promise(r => setTimeout(r, remainder));
    }

    const endTime = Date.now();
    const realDuration = endTime - startTime;
    console.log(`✅ Pausa concluída: ${(realDuration / 60000).toFixed(1)} min reais`);

    // 🚨 ALERTA: Se pausou muito mais que o esperado
    if (realDuration > ms * 1.3) { // 30% de margem
        const diff = ((realDuration / ms) * 100).toFixed(0);
        console.error(`🚨 ANOMALIA: Pausa foi ${diff}% maior que o planejado! Possível freeze detectado.`);
    }
};

function ensureGuildData(state, guildId) {
    if (!state.guildData[guildId]) {
        state.guildData[guildId] = {
            processedMembers: [],
            blockedDMs: [],
            failedQueue: [],
            pendingQueue: [],
            lastRunText: "",
            lastRunAttachments: [],
            lastAnnounceTime: 0,
            totalSuccess: 0,
            totalClosed: 0,
            totalFail: 0
        };
    }
    return state.guildData[guildId];
}

function randomizeParameters() {
    if (IS_LOCAL) {
        currentDelayBase = 2000 + Math.random() * 3000;
        currentBatchBase = 10 + Math.floor(Math.random() * 8);
        console.log(`LOCAL → Delay ~${(currentDelayBase / 1000).toFixed(1)}s | Lote ~${currentBatchBase}`);
        return;
    }
    // 🛡️ DELAYS MAIS SEGUROS (12-22s base, era 10-18s)
    currentDelayBase = 12000 + Math.floor(Math.random() * 10000);
    currentBatchBase = 12 + Math.floor(Math.random() * 10); // 12-22 por lote
    console.log(`STEALTH SEGURO → Delay ${(currentDelayBase / 1000).toFixed(1)}–${((currentDelayBase + DELAY_RANDOM_MS) / 1000).toFixed(1)}s | Lote ${currentBatchBase} ±${BATCH_VARIANCE}`);
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

async function getCachedMembers(guild) {
    const cached = memberCache.get(guild.id);
    if (cached && Date.now() - cached.timestamp < MEMBER_CACHE_TTL) return cached.members;
    try { await guild.members.fetch(); } catch (e) { }
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

function detectSoftBan(stats) {
    const total = stats.success + stats.fail; // (Ignorando DMs fechadas para o banimento geral)
    if (total < SOFT_BAN_MIN_SAMPLES) return false;
    return (stats.fail / total) >= SOFT_BAN_THRESHOLD;
}

async function readAttachmentJSON(url) {
    // 🔧 CORREÇÃO: Removemos a validação estrita de extensão (.json/.txt)
    // As URLs de anexo do Discord possuem parâmetros (?ex=...) que faziam a validação antiga falhar.
    // Agora confiamos que, se tem URL, tentamos baixar e o JSON.parse validará o conteúdo.
    if (!url) {
        return { success: false, error: "❌ Nenhuma URL de arquivo encontrada." };
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
                    resolve({ success: false, error: "❌ O arquivo não é um JSON válido ou está corrompido." });
                }
            });
        }).on('error', (err) => resolve({ success: false, error: `Erro de download: ${err.message}` }));
    });
}

// ============================================================================
// 🧠 PROCESSAMENTO DE IA - MÉTODO CIRÚRGICO ULTRA-SEGURO (V5 - COMPLETO)
// ============================================================================

async function getAiVariation(originalText, globalname) {
    let finalText = originalText.replace(/\{name\}|\{username\}|\{nome\}/gi, globalname);
    if (!model || finalText.length < 10) return finalText;

    try {
        const safeGlobalName = globalname.replace(/["{}\\]/g, '');
        const prompt = `
        FUNÇÃO: Você é um motor de sugestão de sinônimos estrito.
        MISSÃO: Encontre UMA única palavra ou expressão curta (máximo 2 palavras) no texto abaixo que possa ser substituída por um sinônimo.
        ⚠️ REGRAS: NÃO altere links, formatação ou variáveis. Mantenha capitalização.
        Responda ESTRITAMENTE neste formato JSON:
        { "alvo": "palavra_original", "substituto": "sinônimo" }
        Texto: """${finalText}"""
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response.text();
        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(jsonStr);

        if (data.alvo && data.substituto && finalText.includes(data.alvo)) {
            return finalText.replace(data.alvo, data.substituto);
        }
        return finalText;
    } catch (error) {
        console.warn(`⚠️ Erro na V5 Cirúrgica. Usando fallback seguro: ${error.message}`);
        return finalText;
    }
}

// ============================================================================
// 🧮 ANÁLISE DE TAXA DE REJEIÇÃO (ANTI-QUARENTENA V2)
// ============================================================================
function analyzeRejectionRate() {
    if (recentResults.length < 20) return { status: 'normal', rate: 0 }; // Dados insuficientes
    const closed = recentResults.filter(r => r === 'closed').length;
    const total = recentResults.length;
    const rate = closed / total;

    if (rate >= REJECTION_RATE_CRITICAL) {
        return { status: 'critical', rate, closed, total };
    } else if (rate >= REJECTION_RATE_WARNING) {
        return { status: 'warning', rate, closed, total };
    }
    return { status: 'normal', rate, closed, total };
}

function addResult(type) {
    recentResults.push(type);
    if (recentResults.length > REJECTION_WINDOW) recentResults.shift();
}

function checkHourlyLimit() {
    const now = Date.now();
    if (now >= hourlyResetTime) {
        sendsThisHour = 0;
        hourlyResetTime = now + 3600000;
        console.log("🔄 Contador horário resetado.");
    }
    sendsThisHour++;
    if (sendsThisHour >= MAX_SENDS_PER_HOUR) {
        const waitUntilReset = hourlyResetTime - now;
        return { exceeded: true, waitTime: waitUntilReset };
    }
    return { exceeded: false };
}

// ============================================================================
// 📨 FUNÇÃO DE ENVIO
// ============================================================================

async function sendStealthDM(user, rawText, attachments) {
    lastActivityTime = Date.now(); // 🔧 Atualiza heartbeat

    let dmChannel;
    try {
        if (user.dmChannel) dmChannel = user.dmChannel;
        else dmChannel = await user.createDM();
    } catch (e) { return { success: false, reason: "closed" }; }

    let finalContent = rawText;
    if (rawText) {
        const userDisplay = user.globalName || user.username || "amigo";
        finalContent = await getAiVariation(rawText, userDisplay);
    }

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

    const payload = {};
    if (finalContent) payload.content = finalContent;
    if (attachments && attachments.length > 0) payload.files = attachments;

    if (!payload.content && !payload.files) return { success: false, reason: "empty" };

    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await dmChannel.send(payload);
            console.log(`✅ Enviado ${user.tag}: "${finalContent ? finalContent.substring(0, 20) : 'IMG'}..."`);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            const code = err.code || 0;

            if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                console.error("🚨 ALERTA CRÍTICO: SPAM FLAG (40003)");
                await stateManager.modify(s => s.quarantine = true);
                return { success: false, reason: "quarantine" };
            }

            if (code === 50007 || code === 50001) {
                return { success: false, reason: "closed" };
            }

            if (err.retry_after || code === 20016) {
                const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;

                // 🚨 PROTEÇÃO: Rate limit extremo = aborta
                if (waitTime > 3600000) { // > 1 hora
                    console.error(`🚨 Rate Limit Extremo: ${(waitTime / 60000).toFixed(0)}min. Abortando.`);
                    await stateManager.modify(s => {
                        s.active = false;
                        s.quarantine = true;
                    });
                    await sendBackupEmail(`Rate Limit Extremo (${(waitTime / 60000).toFixed(0)}min)`, stateManager.state);
                    return { success: false, reason: "quarantine" };
                }

                console.warn(`⏳ Rate Limit. Esperando ${waitTime / 1000}s.`);
                currentDelayBase += 5000;
                await wait(waitTime);
                continue;
            }

            const backoff = 5000 * attempt;
            console.error(`❌ Erro envio (${attempt}): ${errMsg}. Esperando ${backoff}ms.`);
            if (attempt < RETRY_LIMIT) await wait(backoff);
        }
    }
    return { success: false, reason: "fail" };
}

// ============================================================================
// 🏭 WORKER LOOP (V2 - SISTEMA ANTI-QUARENTENA)
// ============================================================================

async function workerLoop() {
    console.log("🚀 Worker Iniciado - Sistema Anti-Quarentena V2 Ativo");
    const state = stateManager.state;
    const guildId = state.currentAnnounceGuildId;

    if (!guildId || !state.guildData[guildId]) {
        console.error("⚠️ Worker iniciou sem guilda válida.");
        return;
    }

    // Obter o objeto da guilda uma vez fora do loop
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        console.error("❌ Guilda de envio não encontrada ou bot saiu. Interrompendo worker.");
        await stateManager.modify(s => s.active = false);
        return;
    }

    const gd = state.guildData[guildId];

    try {
        let sentInBatch = 0;
        let currentBatchSize = getNextBatchSize();
        let consecutiveClosedCount = 0;
        batchCounter = 0; // Reset contador de lotes

        while (state.active && state.queue.length > 0) {
            lastActivityTime = Date.now(); // 🔧 Heartbeat principal

            if (sentInBatch >= currentBatchSize) {
                batchCounter++; 
                // 📊 Analisa taxa de rejeição
                const analysis = analyzeRejectionRate();
                let pauseDuration;

                if (IS_LOCAL) {
                    pauseDuration = 3000;
                } else {
                    let basePause;
                    if (analysis.status === 'critical') {
                        console.warn(`🚨 TAXA CRÍTICA: ${(analysis.rate * 100).toFixed(1)}% rejeição.`);
                        basePause = EXTENDED_PAUSE_MS; 
                        pauseMultiplier = Math.min(pauseMultiplier * 1.5, 3.0);
                    } else if (analysis.status === 'warning') {
                        console.warn(`⚠️ TAXA ELEVADA: ${(analysis.rate * 100).toFixed(1)}% rejeição.`);
                        basePause = MAX_BATCH_PAUSE_MS; 
                        pauseMultiplier = Math.min(pauseMultiplier * 1.2, 2.0); 
                    } else {
                        // Taxa normal: pausa progressiva por lote
                        if (batchCounter <= 2) basePause = MIN_BATCH_PAUSE_MS; 
                        else if (batchCounter <= 5) basePause = (MIN_BATCH_PAUSE_MS + MAX_BATCH_PAUSE_MS) / 2; 
                        else basePause = MAX_BATCH_PAUSE_MS;
                        
                        pauseMultiplier = Math.max(pauseMultiplier * 0.95, 1.0);
                    }

                    const variance = basePause * 0.3; 
                    pauseDuration = (basePause * pauseMultiplier) + (Math.random() * variance - variance/2);
                    pauseDuration = Math.min(pauseDuration, MAX_ALLOWED_PAUSE_MS);
                }

                console.log(`🔄 Lote ${batchCounter} concluído (${sentInBatch} envios). Pausa: ${(pauseDuration / 60000).toFixed(1)} min.`);
                stateManager.forceSave();
                await updateProgressEmbed();
                await wait(pauseDuration);
                randomizeParameters();

                if (!stateManager.state.active || stateManager.state.queue.length === 0) break;
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
            }

            const userId = state.queue.shift();
            await stateManager.modify(() => { });

            // =======================================================
            // 🆕 NOVO: VERIFICAÇÃO SE O MEMBRO AINDA ESTÁ NO SERVIDOR
            // =======================================================
            let member;
            try {
                member = await guild.members.fetch(userId).catch(() => null);
            } catch (e) { member = null; }

            if (!member) {
                console.log(`🚪 Membro ${userId} não está mais no servidor. Pulando.`);
                await stateManager.modify(s => {
                    const gData = ensureGuildData(s, guildId);
                    if (!gData.processedMembers.includes(userId)) gData.processedMembers.push(userId);
                });
                consecutiveClosedCount = 0;
                continue; 
            }
            // =======================================================

            if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                console.log(`⏭️ Bloqueado: ${userId}`);
                continue;
            }

            let user = client.users.cache.get(userId);
            if (!user) {
                try { user = await client.users.fetch(userId); }
                catch (e) {
                    console.log(`⏭️ Inacessível: ${userId}`);
                    await stateManager.modify(s => {
                        ensureGuildData(s, guildId);
                        if (!s.guildData[guildId].processedMembers.includes(userId)) s.guildData[guildId].processedMembers.push(userId);
                    });
                    continue;
                }
            }

            if (user.bot || isSuspiciousAccount(user)) {
                console.log(`🚫 Ignorado (Bot/Suspeito): ${user.tag}`);
                consecutiveClosedCount = 0; 
                continue;
            }

            // 🚦 CONTROLE DE THROUGHPUT (A cada 10 envios)
            if (sentInBatch > 0 && sentInBatch % HOURLY_CHECK_INTERVAL === 0) {
                const limitCheck = checkHourlyLimit();
                if (limitCheck.exceeded) {
                    const waitMinutes = Math.ceil(limitCheck.waitTime / 60000);
                    console.warn(`⏱️ LIMITE HORÁRIO ATINGIDO (${MAX_SENDS_PER_HOUR}/h). Aguardando ${waitMinutes} min...`);
                    stateManager.forceSave();
                    await updateProgressEmbed();
                    await wait(limitCheck.waitTime);
                    sendsThisHour = 0;
                    hourlyResetTime = Date.now() + 3600000;
                }
            }

            const result = await sendStealthDM(user, state.text, state.attachments);

            // 📊 REGISTRA RESULTADO NO SISTEMA DE ANÁLISE
            if (result.success) addResult('success');
            else if (result.reason === 'closed') addResult('closed');
            else addResult('fail');

            await stateManager.modify(s => {
                const gData = ensureGuildData(s, guildId);

                if (result.success) {
                    s.currentRunStats.success++;
                    consecutiveClosedCount = 0; // ✅ SUCESSO → RESETA CONTADOR
                    const idx = gData.failedQueue.indexOf(userId);
                    if (idx > -1) gData.failedQueue.splice(idx, 1);
                } else {
                    if (result.reason === "closed") {
                        s.currentRunStats.closed++;
                        consecutiveClosedCount++; // 🚫 DM FECHADA → INCREMENTA CONTADOR
                        if (!gData.blockedDMs.includes(userId)) gData.blockedDMs.push(userId);
                    } else if (result.reason === "quarantine") {
                        s.active = false;
                        consecutiveClosedCount = 0;
                    } else {
                        s.currentRunStats.fail++;
                        consecutiveClosedCount = 0;
                        if (!gData.failedQueue.includes(userId)) gData.failedQueue.push(userId);
                    }
                }
                if (!gData.processedMembers.includes(userId)) gData.processedMembers.push(userId);
            });

            // =======================================================
            // 🛡️ CIRCUIT BREAKER (DMs Fechadas Consecutivas)
            // =======================================================
            if (consecutiveClosedCount >= MAX_CONSECUTIVE_CLOSED) {
                console.warn(`🛡️ ALERTA: ${consecutiveClosedCount} DMs fechadas seguidas. Iniciando resfriamento de ${(CLOSED_DM_COOLING_MS / 60000).toFixed(1)} min...`);
                stateManager.forceSave();
                await updateProgressEmbed();
                await wait(CLOSED_DM_COOLING_MS); 
                consecutiveClosedCount = 0; // Reseta
                randomizeParameters(); 
                console.log("❄️ Resfriamento concluído. Retomando envio...");
            }
            // =======================================================

            if (stateManager.state.quarantine) {
                await sendBackupEmail("Quarentena Detectada (API Flag)", stateManager.state);
                break;
            }

            if (detectSoftBan(state.currentRunStats)) {
                console.error("🚨 SOFT-BAN DETECTADO (Taxa de Falha Alta).");
                await stateManager.modify(s => {
                    s.quarantine = true;
                    s.active = false;
                });
                await sendBackupEmail("Soft-Ban (Alta taxa de rejeição)", stateManager.state);
                break;
            }

            updateProgressEmbed().catch(() => { });

            if (result.success) {
                let d = currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS);
                if (Math.random() < EXTRA_LONG_DELAY_CHANCE) {
                    const extra = IS_LOCAL ? 5000 : EXTRA_LONG_DELAY_MS + Math.floor(Math.random() * 25000);
                    d += extra;
                    console.log(`💭 Pensando na vida... +${(extra / 1000).toFixed(0)}s extra`);
                }
                await wait(d);
            } else {
                // 🚨 PENALIDADE ADAPTATIVA
                let penalty;
                if (result.reason === "closed") {
                    const multiplier = Math.min(consecutiveClosedCount, 5); 
                    penalty = IS_LOCAL ? 1000 * multiplier : 5000 * multiplier;
                    if (consecutiveClosedCount >= 2) console.warn(`⚠️ ${consecutiveClosedCount} DMs fechadas seguidas. Delay aumentado: ${(penalty/1000).toFixed(1)}s`);
                } else {
                    penalty = IS_LOCAL ? 2000 : 20000;
                }
                await wait(penalty);
            }
            sentInBatch++;
        }

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
        if (guildId) {
            const gData = ensureGuildData(s, guildId);
            if (s.queue.length > 0) gData.pendingQueue.push(...s.queue);
        }
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
            { name: "❌ Falhas (Erro)", value: `${stats.fail}`, inline: true },
            { name: "🚫 DMs Fechadas", value: `${stats.closed}`, inline: true },
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
            await msg.edit({ content: finalText, embeds: [embed] }).catch(async (err) => {
                if (state.privacyMode === 'public') {
                    await ch.send({ content: finalText, embeds: [embed] });
                } else {
                    if (state.initiatorId) {
                        try {
                            const user = await client.users.fetch(state.initiatorId);
                            await user.send({
                                content: `⚠️ **Relatório Final (Fallback)**\n${finalText}`,
                                embeds: [embed]
                            });
                        } catch (dmErr) {}
                    }
                }
            });
        } catch (e) {
            console.error("❌ Erro ao finalizar envio:", e.message);
        }
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
            .setDescription(`Fila: ${state.queue.length} | Sucesso: ${state.currentRunStats.success} | Fechadas: ${state.currentRunStats.closed}`);
        await msg.edit({ embeds: [embed] });
    } catch (e) { }
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
    return `⏳ ${(requiredCooldown - elapsed) / 60000}m restantes`;
}

// ============================================================================
// 🔔 MONITOR DE CONGELAMENTO (WATCHDOG)
// ============================================================================
setInterval(() => {
    const inactiveTime = Date.now() - lastActivityTime;
    if (inactiveTime > INACTIVITY_THRESHOLD) {
        console.error(`🚨 ALERTA: Processo inativo por ${(inactiveTime / 60000).toFixed(1)} minutos!`);
        console.error("Possível congelamento detectado. Forçando salvamento...");
        stateManager.forceSave();

        if (stateManager.state.active) {
            sendBackupEmail("Inatividade Suspeita (Possível Freeze)", stateManager.state)
                .then(() => {
                    console.error("🔄 Reiniciando processo para recuperação...");
                    process.exit(1); 
                });
        }
    }
}, 60000);

// ============================================================================
// 🎮 LÓGICA CENTRAL DOS COMANDOS
// ============================================================================

async function unifiedReply(ctx, content, embeds = []) {
    const payload = { content, embeds };
    if (ctx.isChatInputCommand?.()) {
        payload.ephemeral = true;
        if (ctx.deferred || ctx.replied) return ctx.editReply(payload);
        return ctx.reply(payload);
    }
    return ctx.reply(payload);
}

async function execAnnounce(ctx, text, attachmentUrl, filtersStr) {
    const guildId = ctx.guild.id;
    const state = stateManager.state;
    const isSlash = ctx.isChatInputCommand?.();
    const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

    const gd = ensureGuildData(state, guildId);

    if (state.active) return unifiedReply(ctx, "❌ Já existe um envio ativo.");

    // 1. Processa filtros
    const parsed = parseSelectors(filtersStr || "");
    let rawInputText = text || "";
    let messageText = parsed.cleaned || rawInputText.replace(/([+-])\{(\d{5,30})\}/g, "").trim();

    // Reconstrução de layout (Slash)
    if (isSlash && messageText) {
        messageText = messageText.replace(/ {2,}/g, '\n\n');
        messageText = messageText.replace(/ ([*•+]) /g, '\n$1 ');
        messageText = messageText.replace(/ (#+) /g, '\n\n$1 ');
        messageText = messageText.replace(/\n /g, '\n');
    }

    if (!messageText && !attachmentUrl) return unifiedReply(ctx, "❌ Envie texto ou anexo.");

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
            const g = ensureGuildData(s, guildId);
            g.pendingQueue = [];
            g.failedQueue = [];
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
        s.text = messageText;
        s.attachments = attachments;
        s.queue = queue;
        s.currentRunStats = { success: 0, fail: 0, closed: 0 };
        s.ignore = parsed.ignore;
        s.only = parsed.only;
        s.privacyMode = isSlash ? 'private' : 'public';
        s.initiatorId = initiatorId;

        const gData = ensureGuildData(s, guildId);
        gData.lastRunText = messageText;
        gData.lastRunAttachments = attachments;
        gData.processedMembers = [...processedSet];
    });

    const msgContent = `🚀 Iniciando envio Stealth para **${queue.length}** membros...`;

    let progressMsg;
    if (ctx.isChatInputCommand?.()) {
        await ctx.deferReply({ ephemeral: true });
        try {
            const dmChannel = await ctx.user.createDM();
            const initialEmbed = new EmbedBuilder()
                .setTitle("📨 Enviando...")
                .setColor("#00AEEF")
                .setDescription(`Fila: ${queue.length} | Sucesso: 0 | Fechadas: 0`);

            progressMsg = await dmChannel.send({ content: msgContent, embeds: [initialEmbed] });
            await ctx.editReply({ content: "✅ Painel de controle enviado para sua DM! Acompanhe por lá." });
        } catch (e) {
            console.error("Erro ao enviar DM inicial:", e);
            await ctx.editReply({ content: "❌ Não consegui te enviar DM. Abra suas DMs e tente novamente." });
            await stateManager.modify(s => s.active = false);
            return;
        }
    } else {
        progressMsg = await unifiedReply(ctx, msgContent);
    }

    await stateManager.modify(s => {
        s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
    });

    startProgressUpdater();
    startWorker();
}

async function execResume(ctx, attachmentUrl) {
    if (stateManager.state.active) return unifiedReply(ctx, "⚠️ Já ativo.");

    let stateToLoad = null;
    let resumeSource = "local";
    const isSlash = ctx.isChatInputCommand?.();
    const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

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
    const gd = ensureGuildData(s, ctx.guild.id);

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
        st.privacyMode = isSlash ? 'private' : 'public';
        st.initiatorId = initiatorId;

        const g = ensureGuildData(st, ctx.guild.id);
        g.pendingQueue = [];
        g.failedQueue = [];
    });

    const msgContent = `🔄 Retomando envio (${resumeSource}) para **${allIds.length}** membros...`;
    let progressMsg;

    if (ctx.isChatInputCommand?.()) {
        await ctx.deferReply({ ephemeral: true });
        try {
            const dmChannel = await ctx.user.createDM();
            const dmEmbed = new EmbedBuilder()
                .setTitle("📨 Retomando...")
                .setColor("#00AEEF")
                .setDescription(`Fila: ${allIds.length} | Sucesso: 0`);
            progressMsg = await dmChannel.send({ content: msgContent, embeds: [dmEmbed] });
            await ctx.editReply({ content: "✅ Painel de retomada enviado para sua DM!" });
        } catch (e) {
            console.error("Erro DM Resume:", e);
            await ctx.editReply({ content: "❌ Erro ao enviar DM. Verifique suas configurações." });
            await stateManager.modify(s => s.active = false);
            return;
        }
    } else {
        progressMsg = await unifiedReply(ctx, msgContent);
    }

    await stateManager.modify(st => {
        st.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
    });
    startProgressUpdater();
    startWorker();
}

async function execStop(ctx) {
    if (ctx.isChatInputCommand?.()) await ctx.deferReply({ ephemeral: true });
    await stateManager.modify(s => s.active = false);
    await sendBackupEmail("Stop Manual", stateManager.state);
    unifiedReply(ctx, "🛑 Parado (Backup enviado).");
}

async function execStatus(ctx) {
    if (ctx.isChatInputCommand?.()) await ctx.deferReply({ ephemeral: true });
    const state = stateManager.state;
    const gd = ensureGuildData(state, ctx.guild.id);
    const isActive = state.active && state.currentAnnounceGuildId === ctx.guild.id;

    const embed = new EmbedBuilder()
        .setTitle("📊 Status Stealth")
        .setColor(isActive ? 0x00FF00 : 0x808080)
        .addFields(
            { name: "Estado", value: isActive ? "🟢 Ativo" : "⚪ Parado", inline: true },
            { name: "Pendentes", value: `${gd.pendingQueue?.length || 0}`, inline: true },
            { name: "Fila Atual", value: `${state.queue.length}`, inline: true },
            { name: "Rejeição Atual", value: `${(analyzeRejectionRate().rate * 100).toFixed(1)}%`, inline: true }
        );

    unifiedReply(ctx, "", [embed]);
}

// ============================================================================
// 📝 REGISTRO & HANDLERS DE COMANDOS
// ============================================================================

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
    } catch (e) {
        console.error("❌ Erro ao registrar Slash Commands:", e);
    }
}

// HANDLER: SLASH (/)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "⛔ Sem permissão.", ephemeral: true });
    }

    const { commandName } = interaction;
    try {
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
    } catch (error) {
        console.error(`💥 Erro ao executar comando /${commandName}:`, error);
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
    console.log(`🛡️ Anti-Freeze System: ATIVO`);
    console.log(`⏱️ Watchdog Timeout: ${INACTIVITY_THRESHOLD / 60000} minutos`);
    await registerSlashCommands();
    if (stateManager.state.active) startWorker();
});

process.on("unhandledRejection", (err) => console.error("❌ Unhandled Rejection:", err));
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    stateManager.forceSave();
    process.exit(1);
});
client.on("error", (err) => console.error("❌ Client Error:", err));

if (!process.env.DISCORD_TOKEN) {
    console.error("❌ Erro: DISCORD_TOKEN ausente.");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("❌ Falha no login:", err);
    process.exit(1);
});