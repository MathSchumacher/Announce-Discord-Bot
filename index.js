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
// 🌍 1. DETECÇÃO DE AMBIENTE & CONSTANTES GLOBAIS
// ============================================================================

// Detecta se estamos rodando na nuvem (Railway/Render) ou Localmente
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;

// Email de destino para backups de emergência
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// ============================================================================
// ⚙️ 2. CONFIGURAÇÕES AVANÇADAS (V4.4 FULL COMPLETE)
// ============================================================================

// 🛡️ CIRCUIT BREAKER & REJEIÇÃO (Proteção contra DMs fechadas)
const MAX_CONSECUTIVE_CLOSED = 3;            // Para após 3 DMs fechadas seguidas
const CLOSED_DM_COOLING_MS = 12 * 60 * 1000; // 12 minutos de resfriamento (geladeira)

// Janela de análise de saúde do envio
const REJECTION_WINDOW = 50;                 // Analisa últimos 50 envios
const REJECTION_RATE_WARNING = 0.30;         // 30% falhas = Cautela
const REJECTION_RATE_CRITICAL = 0.40;        // 40% falhas = Crítico

// ⏱️ LIMITES DE THROUGHPUT (Segurança da conta)
const MAX_SENDS_PER_HOUR = 180;              // Limite seguro do Discord
const HOURLY_CHECK_INTERVAL = 10;            // Verifica limites a cada 10 envios

// ⏸️ PAUSAS PROGRESSIVAS (ANTI-QUARENTENA)
const MIN_BATCH_PAUSE_MS = 3 * 60 * 1000;    // 3 min (Mínimo inicial)
const MAX_BATCH_PAUSE_MS = 8 * 60 * 1000;    // 8 min (Padrão)
const EXTENDED_PAUSE_MS = 15 * 60 * 1000;    // 15 min (Se taxa de erro alta)
const ABSOLUTE_MAX_PAUSE_MS = 25 * 60 * 1000; // 25 min (Teto máximo absoluto)

// 💤 SEGURANÇA & WATCHDOG
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 min sem atividade = Freeze detectado
const MIN_ACCOUNT_AGE_DAYS = 30;             // Ignora contas novas (anti-trap)
const IGNORE_NO_AVATAR = true;               // Ignora contas sem foto (filtro de qualidade)
const RETRY_LIMIT = 3;                       // Tentativas de reenvio por rede
const SAVE_THRESHOLD = 5;                    // Frequência de salvamento em disco

// 🎲 DELAYS & HUMANIZAÇÃO
const EXTRA_LONG_DELAY_CHANCE = 0.15;        // 15% chance de pausa longa aleatória
const EXTRA_LONG_DELAY_MS = 25000;           // +25s pausa longa

// 🧬 CACHE DE MEMBROS
const MEMBER_CACHE_TTL = 5 * 60 * 1000;      // Cache de membros por 5 minutos

// ============================================================================
// 🧠 3. CONFIGURAÇÃO DA IA & SERVIÇOS EXTERNOS
// ============================================================================

// Configuração do Google Gemini
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" }) : null;

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ============================================================================
// 🛠️ 4. FUNÇÕES UTILITÁRIAS GLOBAIS (HELPERS)
// ============================================================================

/**
 * Simula tempo de digitação humano baseado no tamanho do texto.
 */
function calculateTypingTime(text) {
    if (!text) return 1500;
    const ms = (text.length / 15) * 1000;
    return Math.min(9000, Math.max(2500, ms));
}

/**
 * Identifica contas suspeitas ou bots para evitar desperdício de API.
 */
function isSuspiciousAccount(user) {
    const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (ageInDays < MIN_ACCOUNT_AGE_DAYS) return true;
    if (IGNORE_NO_AVATAR && !user.avatar) return true;
    return false;
}

/**
 * Processa os filtros de comando (+ID, -ID, force).
 */
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
    
    return { 
        cleaned: hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned, 
        ignore, 
        only, 
        hasForce 
    };
}

/**
 * Cache de Membros para evitar chamadas de API repetidas e lentas.
 */
const memberCache = new Map();

async function getCachedMembers(guild) {
    const cached = memberCache.get(guild.id);
    if (cached && Date.now() - cached.timestamp < MEMBER_CACHE_TTL) {
        return cached.members;
    }
    
    try { 
        console.log(`[Cache] Baixando lista de membros atualizada de ${guild.name}...`);
        await guild.members.fetch(); 
    } catch (e) { 
        console.error("Erro no fetch de membros:", e.message); 
    }
    
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

/**
 * Baixa JSON de anexo para a função Resume.
 */
async function readAttachmentJSON(url) {
    if (!url) return { success: false, error: "❌ Nenhuma URL de arquivo encontrada." };
    
    return new Promise(resolve => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, state: parsed });
                } catch (e) {
                    resolve({ success: false, error: "❌ O arquivo não é um JSON válido." });
                }
            });
        }).on('error', (err) => resolve({ success: false, error: `Erro de Download: ${err.message}` }));
    });
}

/**
 * IA Variação de Texto - BLINDADA PARA MANTER IDIOMA.
 */
async function getAiVariation(originalText, globalname) {
    let finalText = originalText.replace(/\{name\}|\{username\}|\{nome\}/gi, globalname);
    
    if (!model || finalText.length < 10) return finalText;

    try {
        const safeGlobalName = globalname.replace(/["{}\\]/g, '');
        const prompt = `
        ROLE: You are a strict synonym replacement engine.
        TASK: Identify ONE word or short expression (max 2 words) in the provided text and replace it with a contextual synonym.
        
        ⚠️ MANDATORY RULES:
        1. DETECT the language of the input text (Portuguese, English, Spanish, etc).
        2. The "substituto" MUST be in the EXACT SAME LANGUAGE as the input text. Do NOT translate.
        3. Do NOT change links, formatting (bold, italics), or special variables.
        4. Output JSON ONLY: { "alvo": "original_word", "substituto": "synonym" }
        
        Input Text: """${finalText}"""
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
        return finalText;
    }
}

// ============================================================================
// 💾 5. GERENCIADOR DE ESTADO (PERSISTÊNCIA ISOLADA)
// ============================================================================

class StateManager {
    constructor(filePath, botId) {
        this.filePath = filePath;
        this.botId = botId;
        this.state = this.load();
        this.saveQueue = Promise.resolve();
        this.unsavedChanges = 0;
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
            quarantine: false,          // Indica se o bot está banido/suspenso
            lastError: null,            // Armazena a mensagem de erro exata do Discord
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

            // Reconverte Arrays para Sets
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // AUTO-FIX: Se carregar ativo mas sem fila (crash anterior), reseta.
            if (loaded.active && (!loaded.queue || loaded.queue.length === 0)) {
                console.log(`[Bot ${this.botId}] ⚠️ Auto-Fix: Bot estava marcado como ativo, mas fila vazia. Resetando.`);
                loaded.active = false;
            }

            // Garante estrutura do guildData
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = Array.isArray(gd.processedMembers) ? gd.processedMembers : [];
                gd.blockedDMs = Array.isArray(gd.blockedDMs) ? gd.blockedDMs : [];
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
            }
            return loaded;
        } catch (e) {
            console.log(`[Bot ${this.botId}] ℹ️ Iniciando com novo arquivo de estado.`);
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
        } catch (e) {
            console.error(`[Bot ${this.botId}] ❌ Erro ao salvar estado:`, e.message);
        }
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
}

// ============================================================================
// 🤖 6. CLASSE STEALTH BOT (LÓGICA PRINCIPAL)
// ============================================================================

class StealthBot {
    constructor(token, id) {
        this.token = token;
        this.id = id;
        this.stateManager = new StateManager(path.resolve(__dirname, `state_${id}.json`), id);
        
        // --- PARÂMETROS DE CONTROLE ---
        this.currentDelayBase = (IS_LOCAL ? 2000 : 12000) + (id * 300); 
        this.currentBatchBase = IS_LOCAL ? 5 : 12;
        
        this.recentResults = [];    
        this.sendsThisHour = 0; 
        this.hourlyResetTime = Date.now() + 3600000;
        this.pauseMultiplier = 1.0;
        this.batchCounter = 0;
        
        this.lastActivityTime = Date.now();
        this.workerRunning = false;
        this.progressUpdaterHandle = null;

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildMembers
            ],
            partials: [Partials.Channel]
        });
        this.setupWatchdog();
    }

    /**
     * Wait seguro e cancelável via /stop.
     * Verifica o estado a cada segundo para sair imediatamente se necessário.
     */
    async wait(ms) {
        this.lastActivityTime = Date.now();
        
        if (ms < 5000) return new Promise(r => setTimeout(r, ms));
        
        const seconds = Math.ceil(ms / 1000);
        
        if (seconds > 60) {
            console.log(`[Bot ${this.id}] 💤 Iniciando espera longa de ${(seconds/60).toFixed(1)} min.`);
        }

        for (let i = 0; i < seconds; i++) {
            // Se ativo for falso ou quarentena, aborta o wait imediatamente
            if (!this.stateManager.state.active || this.stateManager.state.quarantine) {
                return; 
            }
            
            await new Promise(r => setTimeout(r, 1000));
            this.lastActivityTime = Date.now(); 
        }
    }

    randomizeParameters() {
        if (IS_LOCAL) {
            this.currentDelayBase = 2000 + Math.random() * 2000;
            this.currentBatchBase = 5 + Math.floor(Math.random() * 5);
        } else {
            this.currentDelayBase = 12000 + Math.floor(Math.random() * 10000);
            this.currentBatchBase = 12 + Math.floor(Math.random() * 10);
        }
        console.log(`[Bot ${this.id}] 🎲 Novos Params: Delay ~${(this.currentDelayBase/1000).toFixed(1)}s | Lote ${this.currentBatchBase}`);
    }

    analyzeRejectionRate() {
        if (this.recentResults.length < 20) return { status: 'normal', rate: 0 };
        const closed = this.recentResults.filter(r => r === 'closed').length;
        const total = this.recentResults.length;
        const rate = closed / total;

        if (rate >= REJECTION_RATE_CRITICAL) return { status: 'critical', rate, closed, total };
        if (rate >= REJECTION_RATE_WARNING) return { status: 'warning', rate, closed, total };
        return { status: 'normal', rate, closed, total };
    }

    addResult(type) {
        this.recentResults.push(type);
        if (this.recentResults.length > REJECTION_WINDOW) this.recentResults.shift();
    }

    checkHourlyLimit() {
        const now = Date.now();
        if (now >= this.hourlyResetTime) {
            this.sendsThisHour = 0;
            this.hourlyResetTime = now + 3600000;
            console.log(`[Bot ${this.id}] 🔄 Contador horário resetado.`);
        }
        this.sendsThisHour++;
        if (this.sendsThisHour >= MAX_SENDS_PER_HOUR) {
            return { exceeded: true, waitTime: this.hourlyResetTime - now };
        }
        return { exceeded: false };
    }

    ensureGuildData(guildId) {
        const s = this.stateManager.state;
        if (!s.guildData[guildId]) {
            s.guildData[guildId] = {
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
        return s.guildData[guildId];
    }

    async sendBackupEmail(reason, state) {
        console.log(`[Bot ${this.id}] 📧 Preparando backup de emergência. Motivo: ${reason}`);
        const guildId = state.currentAnnounceGuildId;
        const gd = guildId ? this.ensureGuildData(guildId) : null;
        
        let remainingUsers = [...state.queue];
        if (gd) {
            const allPending = [...state.queue, ...gd.pendingQueue, ...gd.failedQueue];
            remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
        }

        if (remainingUsers.length === 0) return;

        const backupData = {
            source: `StealthBot_Instance_${this.id}_V4.4`,
            timestamp: new Date().toISOString(),
            reason: reason,
            lastError: state.lastError, // Inclui o erro no JSON
            text: state.text || (gd?.lastRunText || ""),
            attachments: state.attachments || (gd?.lastRunAttachments || []),
            currentAnnounceGuildId: guildId,
            remainingQueue: remainingUsers, // CHAVE CRÍTICA PARA O RESUME
            stats: state.currentRunStats
        };

        const jsonContent = JSON.stringify(backupData, null, 2);
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: TARGET_EMAIL,
            subject: `🚨 Bot ${this.id} STOP: ${reason}`,
            text: `ATENÇÃO: O bot parou.\nMotivo: ${reason}\nErro Específico: ${state.lastError || "N/A"}\nRestantes: ${remainingUsers.length}\n\nCOMO RETOMAR:\nUse o comando /resume e anexe este arquivo JSON.`,
            attachments: [{ filename: `backup_${Date.now()}.json`, content: jsonContent }]
        };

        try { await transporter.sendMail(mailOptions); } catch (e) { console.error(e); }
    }

    async sendStealthDM(user, rawText, attachments) {
        this.lastActivityTime = Date.now();

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
            if (Math.random() > 0.25 && finalContent) {
                await dmChannel.sendTyping();
                await this.wait(calculateTypingTime(finalContent));
            } else {
                await this.wait(1000 + Math.random() * 2000);
            }
        } catch (e) {}

        const payload = {};
        if (finalContent) payload.content = finalContent;
        if (attachments && attachments.length > 0) payload.files = attachments;
        if (!payload.content && !payload.files) return { success: false, reason: "empty" };

        for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
            try {
                await dmChannel.send(payload);
                console.log(`[Bot ${this.id}] ✅ Enviado: ${user.tag}`);
                return { success: true };
            } catch (err) {
                const errMsg = (err.message || "").toLowerCase();
                const code = err.code || 0;

                // 🚨 TRATAMENTO EXPLÍCITO DE BANIMENTO/SPAM (40003)
                if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                    console.error(`[Bot ${this.id}] 🚨 FLAG CRÍTICA DETECTADA: ${errMsg}`);
                    await this.stateManager.modify(s => {
                        s.quarantine = true;
                        s.lastError = `API Error ${code}: ${err.message}`; // Salva erro exato
                    });
                    return { success: false, reason: "quarantine" };
                }

                if (code === 50007 || code === 50001) return { success: false, reason: "closed" };

                if (err.retry_after || code === 20016) {
                    const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;
                    if (waitTime > 3600000) {
                        await this.stateManager.modify(s => {
                            s.quarantine = true;
                            s.lastError = `Rate Limit Extremo (${(waitTime/60000).toFixed(0)}m)`;
                        });
                        return { success: false, reason: "quarantine" };
                    }
                    console.warn(`[Bot ${this.id}] ⏳ Rate Limit. Esperando ${waitTime/1000}s.`);
                    await this.wait(waitTime);
                    continue;
                }
                const backoff = 5000 * attempt;
                if (attempt < RETRY_LIMIT) await this.wait(backoff);
            }
        }
        return { success: false, reason: "fail" };
    }

    // ========================================================================
    // 🏭 7. WORKER LOOP (V4.4 - COMPLETO)
    // ========================================================================

    async workerLoop() {
        console.log(`[Bot ${this.id}] 🚀 Worker Ativo - V4.4 (Full Verbose)`);
        const state = this.stateManager.state;
        const guildId = state.currentAnnounceGuildId;

        if (!guildId) { await this.stateManager.modify(s => s.active = false); return; }

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { await this.stateManager.modify(s => s.active = false); return; }

        const gd = this.ensureGuildData(guildId);
        
        let sentInBatch = 0;
        let currentBatchSize = this.currentBatchBase;
        let consecutiveClosedCount = 0; 
        this.batchCounter = 0;

        try {
            while (state.active && state.queue.length > 0) {
                this.lastActivityTime = Date.now();

                // -----------------------------------------------------------
                // 🛑 LÓGICA DE PAUSAS PROGRESSIVAS (ENTRE LOTES)
                // -----------------------------------------------------------
                if (sentInBatch >= currentBatchSize) {
                    this.batchCounter++;
                    const analysis = this.analyzeRejectionRate();
                    
                    let basePause;
                    if (IS_LOCAL) {
                        basePause = 3000;
                    } else {
                        if (analysis.status === 'critical') {
                            basePause = EXTENDED_PAUSE_MS;
                            this.pauseMultiplier = Math.min(this.pauseMultiplier * 1.5, 3.0);
                        } else if (analysis.status === 'warning') {
                            basePause = MAX_BATCH_PAUSE_MS;
                            this.pauseMultiplier = Math.min(this.pauseMultiplier * 1.2, 2.0);
                        } else {
                            basePause = this.batchCounter <= 2 ? MIN_BATCH_PAUSE_MS : MAX_BATCH_PAUSE_MS;
                            this.pauseMultiplier = Math.max(this.pauseMultiplier * 0.95, 1.0);
                        }
                    }

                    const variance = basePause * 0.3; 
                    let pauseDuration = (basePause * this.pauseMultiplier) + (Math.random() * variance - variance/2);
                    pauseDuration = Math.min(pauseDuration, ABSOLUTE_MAX_PAUSE_MS);

                    console.log(`[Bot ${this.id}] 🔄 Pausa Lote: ${(pauseDuration/60000).toFixed(1)} min.`);
                    
                    this.stateManager.forceSave();
                    await this.updateProgressEmbed();
                    
                    await this.wait(pauseDuration);
                    this.randomizeParameters();

                    if (!state.active) break;
                    
                    sentInBatch = 0;
                    currentBatchSize = this.currentBatchBase + (Math.floor(Math.random() * 5));
                }

                // -----------------------------------------------------------
                // 👤 PROCESSAMENTO
                // -----------------------------------------------------------
                const userId = state.queue.shift();
                await this.stateManager.modify(() => {}); 

                // Verifica membro (se saiu da guilda)
                let member;
                try { member = await guild.members.fetch(userId).catch(() => null); } catch(e) {}

                if (!member) {
                    // Usuário não existe mais, apenas registra e pula
                    if (!gd.processedMembers.includes(userId)) gd.processedMembers.push(userId);
                    continue;
                }

                if (gd.blockedDMs && gd.blockedDMs.includes(userId)) continue;

                let user = this.client.users.cache.get(userId);
                if (!user) {
                    try { user = await this.client.users.fetch(userId); } catch (e) { continue; }
                }

                if (user.bot || isSuspiciousAccount(user)) {
                    console.log(`[Bot ${this.id}] 🚫 Ignorado: ${user.tag}`);
                    continue;
                }

                if (sentInBatch > 0 && sentInBatch % HOURLY_CHECK_INTERVAL === 0) {
                    const limitCheck = this.checkHourlyLimit();
                    if (limitCheck.exceeded) {
                        console.warn(`[Bot ${this.id}] ⏱️ Limite Hora. Esperando...`);
                        await this.updateProgressEmbed();
                        await this.wait(limitCheck.waitTime);
                    }
                }

                // 🚀 ENVIO REAL
                const result = await this.sendStealthDM(user, state.text, state.attachments);

                if (result.success) this.addResult('success');
                else if (result.reason === 'closed') this.addResult('closed');
                else this.addResult('fail');

                await this.stateManager.modify(s => {
                    const g = this.ensureGuildData(guildId);
                    
                    if (result.success) {
                        s.currentRunStats.success++;
                        consecutiveClosedCount = 0;
                        const idx = g.failedQueue.indexOf(userId);
                        if (idx > -1) g.failedQueue.splice(idx, 1);
                    } else if (result.reason === 'closed') {
                        s.currentRunStats.closed++;
                        consecutiveClosedCount++;
                        if (!g.blockedDMs.includes(userId)) g.blockedDMs.push(userId);
                    } else if (result.reason === 'quarantine') {
                        s.active = false;
                        s.quarantine = true;
                        // lastError definido no sendStealthDM
                    } else {
                        s.currentRunStats.fail++;
                        consecutiveClosedCount = 0;
                        if (!g.failedQueue.includes(userId)) g.failedQueue.push(userId);
                    }
                    if (!g.processedMembers.includes(userId)) g.processedMembers.push(userId);
                });

                // -----------------------------------------------------------
                // ⚡ CIRCUIT BREAKER
                // -----------------------------------------------------------
                if (consecutiveClosedCount >= MAX_CONSECUTIVE_CLOSED) {
                    console.warn(`[Bot ${this.id}] 🛡️ ALERTA: DMs Fechadas. Resfriando...`);
                    await this.updateProgressEmbed();
                    await this.wait(CLOSED_DM_COOLING_MS); 
                    
                    consecutiveClosedCount = 0; 
                    this.recentResults = []; 
                    sentInBatch = 0; 
                    console.log(`[Bot ${this.id}] ❄️ Resfriado.`);
                }

                // 🚨 CHECAGEM DE QUARENTENA NO LOOP
                if (state.quarantine) {
                    console.error(`[Bot ${this.id}] 🛑 PARANDO POR QUARENTENA. Motivo: ${state.lastError}`);
                    await this.finalizeSending(); // Força update da UI
                    await this.sendBackupEmail(`Quarentena: ${state.lastError}`, state);
                    break;
                }

                await this.updateProgressEmbed().catch(() => {});

                if (result.success) {
                    let d = this.currentDelayBase + Math.floor(Math.random() * 8000);
                    if (Math.random() < EXTRA_LONG_DELAY_CHANCE) {
                        d += (IS_LOCAL ? 5000 : EXTRA_LONG_DELAY_MS);
                    }
                    await this.wait(d);
                } else {
                    let penalty = result.reason === 'closed' ? 2000 : 10000;
                    await this.wait(penalty);
                }
                
                sentInBatch++;
            } 

            if (state.queue.length === 0 && state.active) {
                console.log(`[Bot ${this.id}] ✅ Fim da Fila.`);
                await this.finalizeSending();
            }

        } catch (err) {
            console.error(`[Bot ${this.id}] 💥 Erro Worker:`, err);
            await this.stateManager.modify(s => s.lastError = `Crash: ${err.message}`);
            await this.sendBackupEmail(`Erro Crítico: ${err.message}`, state);
        } finally {
            this.workerRunning = false;
            if (this.stateManager.state.queue.length > 0 && (!this.stateManager.state.active)) {
                await this.finalizeSending();
            }
            this.stateManager.forceSave();
        }
    }

    startWorker() {
        if (this.workerRunning) return;
        this.workerRunning = true;
        this.workerLoop().catch(err => {
            console.error(`[Bot ${this.id}] Worker Crash:`, err);
            this.workerRunning = false;
        });
    }

    // ========================================================================
    // 📊 8. FINALIZAÇÃO E UI
    // ========================================================================

    async finalizeSending() {
        this.stopProgressUpdater();
        const s = this.stateManager.state;
        const guildId = s.currentAnnounceGuildId;

        await this.stateManager.modify(st => {
            if (guildId && st.queue.length > 0) {
                const g = this.ensureGuildData(guildId);
                g.pendingQueue.push(...st.queue);
            }
            st.queue = [];
            st.active = false;
        });
        this.stateManager.forceSave();

        const remaining = (s.guildData[guildId]?.pendingQueue.length || 0);
        // Cor vermelha se foi quarentena
        const embedColor = s.quarantine ? 0xFF0000 : (remaining === 0 ? 0x00FF00 : 0xFFA500);

        const embed = new EmbedBuilder()
            .setTitle(s.quarantine ? `🚨 STOP: BOT BANIDO/SUSPENSO` : `📬 Relatório Final (Bot ${this.id})`)
            .setColor(embedColor)
            .addFields(
                { name: "✅ Sucesso", value: `${s.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${s.currentRunStats.fail}`, inline: true },
                { name: "🚫 DMs Fechadas", value: `${s.currentRunStats.closed}`, inline: true },
                { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
            );

        if (s.quarantine) {
            embed.addFields({ 
                name: "🛑 MOTIVO DO ERRO", 
                value: `**${s.lastError || "Erro desconhecido da API"}**\nO bot foi interrompido. Verifique backup.`, 
                inline: false 
            });
        }

        const finalText = s.quarantine ? "🚨 **ENVIO CANCELADO POR ERRO CRÍTICO**" : (remaining === 0 ? "✅ Finalizado!" : `⏸️ Parado. Restam ${remaining}.`);

        if (s.progressMessageRef) {
            try {
                const ch = await this.client.channels.fetch(s.progressMessageRef.channelId);
                const msg = await ch.messages.fetch(s.progressMessageRef.messageId);
                await msg.edit({ content: finalText, embeds: [embed] });
            } catch (e) {}
        }

        await this.stateManager.modify(s => s.currentAnnounceGuildId = null);
        this.stateManager.forceSave();
    }

    async updateProgressEmbed() {
        const s = this.stateManager.state;
        if (!s.progressMessageRef) return;
        try {
            const ch = await this.client.channels.fetch(s.progressMessageRef.channelId);
            const msg = await ch.messages.fetch(s.progressMessageRef.messageId);
            const remaining = s.queue.length;

            const embed = new EmbedBuilder()
                .setTitle(`📨 Bot ${this.id}: Enviando...`)
                .setColor("#00AEEF")
                .addFields(
                    { name: "✅ Sucesso", value: `${s.currentRunStats.success}`, inline: true },
                    { name: "❌ Falhas", value: `${s.currentRunStats.fail}`, inline: true },
                    { name: "🚫 DMs Fechadas", value: `${s.currentRunStats.closed}`, inline: true },
                    { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
                );
            
            await msg.edit({ embeds: [embed] });
        } catch (e) {}
    }

    startProgressUpdater() {
        if (this.progressUpdaterHandle) return;
        this.progressUpdaterHandle = setInterval(() => { 
            if (this.stateManager.state.active) this.updateProgressEmbed(); 
        }, 10000);
    }

    stopProgressUpdater() {
        if (this.progressUpdaterHandle) { clearInterval(this.progressUpdaterHandle); this.progressUpdaterHandle = null; }
    }

    // ========================================================================
    // 🕹️ 9. COMANDOS (ANNOUNCE, UPDATE, RESUME)
    // ========================================================================

    async handleAnnounce(ctx, text, attachmentUrl, filtersStr) {
        const s = this.stateManager.state;
        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;
        
        // 🚨 CHECAGEM DE QUARENTENA
        if (s.quarantine) {
            const errorMsg = `⛔ **SISTEMA EM QUARENTENA**\nMotivo: ${s.lastError}.\nUse \`!reset\` para limpar a flag.`;
            return isSlash ? ctx.reply({content: errorMsg, ephemeral: true}) : ctx.reply(errorMsg);
        }

        if (s.active) return isSlash ? ctx.reply({content: "❌ Ocupado. Use !reset.", ephemeral: true}) : ctx.reply("❌ Ocupado.");

        const guildId = ctx.guild.id;
        const gd = this.ensureGuildData(guildId);
        
        const parsed = parseSelectors(filtersStr || "");
        let messageText = parsed.cleaned || text || "";
        
        if (isSlash && messageText) {
            messageText = messageText.replace(/ {2,}/g, '\n\n').replace(/ ([*•+]) /g, '\n$1 ').replace(/\n /g, '\n');
        }

        if (!messageText && !attachmentUrl) return isSlash ? ctx.reply({content: "❌ Erro: Sem conteúdo.", ephemeral: true}) : ctx.reply("❌ Erro.");

        const totalRemaining = gd.pendingQueue.length + gd.failedQueue.length;
        if (totalRemaining > 0 && !parsed.hasForce) {
            return isSlash ? ctx.reply({content: `⚠️ Há ${totalRemaining} pendentes. Use /resume ou 'force'.`, ephemeral: true}) : ctx.reply(`⚠️ Há ${totalRemaining} pendentes.`);
        }

        if (parsed.hasForce) {
            await this.stateManager.modify(st => {
                const g = this.ensureGuildData(guildId);
                g.pendingQueue = [];
                g.failedQueue = [];
            });
        }

        if (isSlash) await ctx.deferReply({ ephemeral: true });
        
        const members = await getCachedMembers(ctx.guild);
        const queue = [];
        members.forEach(m => {
            if (m.user.bot) return;
            if (gd.blockedDMs.includes(m.id)) return;
            if (parsed.only.size > 0 && !parsed.only.has(m.id)) return;
            if (parsed.ignore.has(m.id)) return;
            queue.push(m.id);
        });

        if (queue.length === 0) return isSlash ? ctx.editReply("❌ Ninguém.") : ctx.reply("❌ Ninguém.");

        await this.stateManager.modify(st => {
            st.active = true;
            st.quarantine = false;
            st.lastError = null;
            st.currentAnnounceGuildId = guildId;
            st.text = messageText;
            st.attachments = attachmentUrl ? [attachmentUrl] : [];
            st.queue = queue;
            st.currentRunStats = { success: 0, fail: 0, closed: 0 };
            st.privacyMode = isSlash ? 'private' : 'public';
            st.initiatorId = initiatorId;
            st.ignore = parsed.ignore;
            st.only = parsed.only;
            const g = this.ensureGuildData(guildId);
            g.lastRunText = messageText;
            g.lastRunAttachments = st.attachments;
        });

        const infoMsg = `🚀 [Bot ${this.id}] Iniciando envio...`;
        
        if (isSlash) {
            try {
                const user = await ctx.user.createDM();
                const embed = new EmbedBuilder().setTitle(`Bot ${this.id} Iniciado`).setDescription("Monitorando...");
                const dmMsg = await user.send({ content: infoMsg, embeds: [embed] });
                await this.stateManager.modify(st => { st.progressMessageRef = { channelId: dmMsg.channel.id, messageId: dmMsg.id }; });
                await ctx.editReply("✅ Verifique DM.");
            } catch (e) {
                await ctx.editReply("❌ Erro DM.");
                await this.stateManager.modify(s => s.active = false);
                return;
            }
        } else {
            const msg = await ctx.reply(infoMsg);
            await this.stateManager.modify(st => { st.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id }; });
        }

        this.startProgressUpdater();
        this.startWorker();
    }

    // 🔥 COMANDO DE UPDATE: Adiciona novos membros à fila
    async handleUpdate(ctx) {
        const isSlash = ctx.isChatInputCommand?.();
        if (isSlash) await ctx.deferReply({ ephemeral: true });

        const guildId = ctx.guild.id;
        const gd = this.stateManager.state.guildData[guildId]; 

        if (!gd) {
            const msg = "❌ Nenhuma campanha encontrada.";
            return isSlash ? ctx.editReply(msg) : ctx.reply(msg);
        }

        const knownSet = new Set([
            ...gd.processedMembers,
            ...gd.blockedDMs,
            ...gd.failedQueue,
            ...gd.pendingQueue,
            ...this.stateManager.state.queue
        ]);

        const currentMembers = await getCachedMembers(ctx.guild);
        const newTargets = [];

        currentMembers.forEach(m => {
            if (m.user.bot || isSuspiciousAccount(m.user)) return;
            if (!knownSet.has(m.id)) {
                newTargets.push(m.id);
            }
        });

        if (newTargets.length === 0) {
            const msg = "✅ Nenhum membro novo encontrado.";
            return isSlash ? ctx.editReply(msg) : ctx.reply(msg);
        }

        await this.stateManager.modify(s => {
            s.queue.push(...newTargets);
        });

        const msg = `🔄 **Update:** Foram adicionados +${newTargets.length} novos membros à fila.`;
        if (isSlash) await ctx.editReply(msg); else await ctx.reply(msg);
    }

    async handleResume(ctx, attachmentUrl) {
        if (this.stateManager.state.active) return ctx.reply("⚠️ Já ativo.");
        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

        let loadedBackup = null;
        if (attachmentUrl) {
            const res = await readAttachmentJSON(attachmentUrl);
            if (!res.success) return ctx.reply(res.error);
            loadedBackup = res.state;
        }

        const s = this.stateManager.state;
        const gd = this.ensureGuildData(ctx.guild.id);
        
        // Coleta membros de todas as fontes possíveis
        let potentialIds = [ ...s.queue, ...gd.pendingQueue, ...gd.failedQueue ];

        if (loadedBackup) {
            // 🔥 CORREÇÃO: Lê remainingQueue do backup
            const backupQ = loadedBackup.remainingQueue || loadedBackup.queue || [];
            potentialIds = [...potentialIds, ...backupQ];
            if (loadedBackup.text) s.text = loadedBackup.text;
            if (loadedBackup.attachments) s.attachments = loadedBackup.attachments;
        }

        const allIds = [...new Set(potentialIds)].filter(id => !gd.blockedDMs.includes(id));

        if (allIds.length === 0) return ctx.reply("✅ Nada para retomar.");

        await this.stateManager.modify(st => {
            st.active = true;
            st.quarantine = false;
            st.lastError = null;
            st.currentAnnounceGuildId = ctx.guild.id;
            st.queue = allIds;
            st.currentRunStats = { success: 0, fail: 0, closed: 0 };
            st.initiatorId = initiatorId;
            st.privacyMode = isSlash ? 'private' : 'public';
            
            // Limpa as pendências pois já foram movidas para a fila principal
            const g = this.ensureGuildData(ctx.guild.id);
            g.pendingQueue = [];
            g.failedQueue = [];
        });

        const infoMsg = `🔄 [Bot ${this.id}] Retomando envio para **${allIds.length}** membros...`;

        if (isSlash) {
            await ctx.deferReply({ephemeral: true});
            try {
                const user = await ctx.user.createDM();
                const embed = new EmbedBuilder().setTitle(`Retomando`).setDescription("...");
                const dmMsg = await user.send({ content: infoMsg, embeds: [embed] });
                await this.stateManager.modify(st => { st.progressMessageRef = { channelId: dmMsg.channel.id, messageId: dmMsg.id }; });
                await ctx.editReply("✅ Retomado! Verifique DM.");
            } catch(e) { await ctx.editReply("❌ Erro DM."); }
        } else {
            const msg = await ctx.reply(infoMsg);
            await this.stateManager.modify(st => { st.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id }; });
        }

        this.startProgressUpdater();
        this.startWorker();
    }

    setupWatchdog() {
        setInterval(() => {
            if (!this.stateManager.state.active) { this.lastActivityTime = Date.now(); return; }
            const inactiveTime = Date.now() - this.lastActivityTime;
            if (inactiveTime > INACTIVITY_THRESHOLD) {
                console.error(`[Bot ${this.id}] 🚨 Watchdog: Freeze detectado.`);
                this.stateManager.forceSave();
                if (this.stateManager.state.queue.length > 0) this.sendBackupEmail("Watchdog Freeze", this.stateManager.state);
            }
        }, 60000);
    }

    async registerSlashCommands() {
        const commands = [
            new SlashCommandBuilder().setName('announce').setDescription('Iniciar Envio')
                .addStringOption(o => o.setName('texto').setDescription('Mensagem').setRequired(true))
                .addAttachmentOption(o => o.setName('anexo').setDescription('Imagem'))
                .addStringOption(o => o.setName('filtros').setDescription('Ex: force')),
            new SlashCommandBuilder().setName('resume').setDescription('Retomar Envio')
                .addAttachmentOption(o => o.setName('arquivo').setDescription('Backup JSON')),
            new SlashCommandBuilder().setName('update').setDescription('Adiciona novos membros à fila'),
            new SlashCommandBuilder().setName('stop').setDescription('Parar Envio'),
            new SlashCommandBuilder().setName('status').setDescription('Ver Status')
        ];
        const rest = new REST({ version: '10' }).setToken(this.token);
        try { 
            console.log(`[Bot ${this.id}] Registrando Slash Commands...`);
            await rest.put(Routes.applicationCommands(this.client.user.id), { body: commands });
            console.log(`[Bot ${this.id}] ✅ Slash Commands OK.`);
        } catch (e) { 
            console.error(`[Bot ${this.id}] ❌ Erro Slash:`, e); 
        }
    }

    async start() {
        this.client.on('ready', async () => {
            console.log(`✅ [Bot ${this.id}] Online: ${this.client.user.tag}`);
            await this.registerSlashCommands();
            if (this.stateManager.state.active) {
                console.log(`[Bot ${this.id}] ⚠️ Estado 'Ativo' detectado no boot. Retomando worker.`);
                this.startWorker();
            }
        });

        this.client.on('interactionCreate', async interaction => {
            if (!interaction.isChatInputCommand()) return;
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });

            const { commandName } = interaction;
            try {
                if (commandName === 'announce') {
                    const text = interaction.options.getString('texto');
                    const attach = interaction.options.getAttachment('anexo');
                    const filters = interaction.options.getString('filtros');
                    await this.handleAnnounce(interaction, text, attach?.url, filters);
                } else if (commandName === 'resume') {
                    const file = interaction.options.getAttachment('arquivo');
                    await this.handleResume(interaction, file?.url);
                } else if (commandName === 'update') {
                    await this.handleUpdate(interaction);
                } else if (commandName === 'stop') {
                    await interaction.deferReply({ephemeral: true});
                    await this.stateManager.modify(s => s.active = false);
                    await this.sendBackupEmail("Stop Slash", this.stateManager.state);
                    await interaction.editReply("🛑 Parado.");
                } else if (commandName === 'status') {
                    const s = this.stateManager.state;
                    const rate = this.analyzeRejectionRate().rate * 100;
                    const embed = new EmbedBuilder().setTitle(`Status Bot ${this.id}`)
                        .addFields(
                            { name: "Active", value: `${s.active}`, inline: true },
                            { name: "Queue", value: `${s.queue.length}`, inline: true },
                            { name: "Rejection", value: `${rate.toFixed(1)}%`, inline: true },
                            { name: "Quarantine", value: s.quarantine ? "⛔ SIM" : "✅ Não", inline: true }
                        );
                    if (s.quarantine) embed.addFields({name: "Erro", value: `${s.lastError}`, inline: false});
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            } catch (e) { console.error("Erro Interaction:", e); }
        });

        this.client.on("messageCreate", async (message) => {
            if (message.author.bot || !message.content.startsWith('!') || !message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;
            const args = message.content.slice(1).trim().split(/ +/);
            const cmd = args.shift().toLowerCase();
            const fullContent = message.content.slice(cmd.length + 2).trim();

            if (cmd === 'announce') {
                const attachment = message.attachments.first();
                await this.handleAnnounce(message, fullContent, attachment ? attachment.url : null, fullContent);
            } else if (cmd === 'resume') {
                const attachment = message.attachments.first();
                await this.handleResume(message, attachment ? attachment.url : null);
            } else if (cmd === 'update') {
                await this.handleUpdate(message);
            } else if (cmd === 'stop') {
                await this.stateManager.modify(s => s.active = false);
                message.reply("🛑 Parado.");
            } else if (cmd === 'reset') { 
                await this.stateManager.modify(s => { 
                    s.active = false; 
                    s.queue = []; 
                    s.quarantine = false; // Reset também limpa a flag de erro
                    s.lastError = null;
                });
                message.reply("🔄 Reset Forçado (Estado + Quarentena). Bot limpo.");
            }
        });

        await this.client.login(this.token);
    }
}

// ============================================================================
// 🏭 10. INICIALIZADOR MULTI-BOT
// ============================================================================

const bots = [];
function loadBots() {
    let index = 1;
    while (true) {
        const envKey = index === 1 ? 'DISCORD_TOKEN' : `DISCORD_TOKEN${index}`;
        const token = process.env[envKey];
        if (!token) break;
        console.log(`🔌 [System] Inicializando instância ${index}...`);
        const bot = new StealthBot(token, index);
        bot.start();
        bots.push(bot);
        index++;
    }
    if (bots.length === 0) { console.error("❌ ERRO: Sem tokens no .env"); process.exit(1); }
}

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const botStatus = bots.map(b => ({
        id: b.id,
        active: b.stateManager.state.active,
        queue: b.stateManager.state.queue.length,
        quarantine: b.stateManager.state.quarantine,
        success: b.stateManager.state.currentRunStats.success
    }));
    res.end(JSON.stringify({ status: "online", system: "V4.4 Full Verbose", bots: botStatus }));
});
server.listen(PORT, () => {
    console.log(`\n🛡️ SYSTEM V4.4 STARTED | PORT ${PORT}`);
    loadBots();
});

// Tratamento de encerramento seguro
process.on('SIGINT', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });
process.on('SIGTERM', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    bots.forEach(b => b.stateManager.forceSave());
});