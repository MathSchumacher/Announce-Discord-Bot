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
// 🌍 DETECÇÃO DE AMBIENTE & CONSTANTES GLOBAIS
// ============================================================================
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// ============================================================================
// ⚙️ CONFIGURAÇÕES AVANÇADAS (V2.5 ANTI-QUARENTENA)
// ============================================================================

// 🛡️ CIRCUIT BREAKER & REJEIÇÃO
const MAX_CONSECUTIVE_CLOSED = 3;           // Para após 3 DMs fechadas seguidas
const CLOSED_DM_COOLING_MS = 12 * 60 * 1000; // 12 min de resfriamento
const REJECTION_WINDOW = 50;                // Analisa últimos 50 envios
const REJECTION_RATE_WARNING = 0.30;        // 30% = Cautela
const REJECTION_RATE_CRITICAL = 0.40;       // 40% = Crítico

// ⏱️ LIMITES DE THROUGHPUT
const MAX_SENDS_PER_HOUR = 180;             // Máximo 180 envios/hora
const HOURLY_CHECK_INTERVAL = 10;           // Checa a cada 10 envios

// ⏸️ PAUSAS PROGRESSIVAS (ANTI-QUARENTENA)
const MIN_BATCH_PAUSE_MS = 3 * 60 * 1000;   // 3 min (início)
const MAX_BATCH_PAUSE_MS = 8 * 60 * 1000;   // 8 min (padrão)
const EXTENDED_PAUSE_MS = 15 * 60 * 1000;   // 15 min (taxa alta)
const ABSOLUTE_MAX_PAUSE_MS = 25 * 60 * 1000; // 25 min (teto)

// 💤 WATCHDOG & SEGURANÇA
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 min sem atividade = freeze
const MIN_ACCOUNT_AGE_DAYS = 30;            // Ignora contas novas
const IGNORE_NO_AVATAR = true;              // Ignora sem avatar
const RETRY_LIMIT = 3;                      // Tentativas de envio por usuário
const SAVE_THRESHOLD = 5;                   // Salva estado a cada 5 mudanças

// 🎲 DELAYS & HUMANIZAÇÃO
const EXTRA_LONG_DELAY_CHANCE = 0.15;       // 15% chance de pausa longa
const EXTRA_LONG_DELAY_MS = 25000;          // +25s pausa longa

// 🧬 MEMÓRIA E CACHE
const MEMBER_CACHE_TTL = 5 * 60 * 1000;     // Cache de membros

// ============================================================================
// 🧠 CONFIGURAÇÃO DA IA & SERVIÇOS EXTERNOS
// ============================================================================

// Google Gemini
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;

// Nodemailer (Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ============================================================================
// 🛠️ FUNÇÕES UTILITÁRIAS GLOBAIS (PURAS)
// ============================================================================

/**
 * Calcula tempo de "digitação" baseado no tamanho do texto.
 * Simula comportamento humano (2.5s a 9s).
 */
function calculateTypingTime(text) {
    if (!text) return 1500;
    const ms = (text.length / 15) * 1000;
    return Math.min(9000, Math.max(2500, ms));
}

/**
 * Verifica se a conta é suspeita (spam/bot/fake).
 */
function isSuspiciousAccount(user) {
    const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (ageInDays < MIN_ACCOUNT_AGE_DAYS) return true;
    if (IGNORE_NO_AVATAR && !user.avatar) return true;
    return false;
}

/**
 * Parseia filtros de comando:
 * force: Limpa filas pendentes
 * -{ID}: Ignora ID
 * +{ID}: Envia apenas para ID
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
 * Baixa e valida JSON de anexo (para Resume).
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
                    resolve({ success: false, error: "❌ O arquivo não é um JSON válido ou está corrompido." });
                }
            });
        }).on('error', (err) => resolve({ success: false, error: `Erro de download: ${err.message}` }));
    });
}

/**
 * Usa IA para reescrever uma pequena parte do texto (Anti-Spam).
 * Substitui também variáveis como {nome}.
 */
async function getAiVariation(originalText, globalname) {
    let finalText = originalText.replace(/\{name\}|\{username\}|\{nome\}/gi, globalname);
    
    // Se não tem IA ou texto curto, retorna apenas com variáveis trocadas
    if (!model || finalText.length < 10) return finalText;

    try {
        const safeGlobalName = globalname.replace(/["{}\\]/g, '');
        const prompt = `
        FUNÇÃO: Você é um motor de sugestão de sinônimos estrito.
        MISSÃO: Encontre UMA única palavra ou expressão curta (máximo 2 palavras) no texto abaixo que possa ser substituída por um sinônimo contextual.
        ⚠️ REGRAS: 
        1. NÃO altere links, formatação ou variáveis.
        2. Mantenha a mesma capitalização.
        3. Responda ESTRITAMENTE neste formato JSON: { "alvo": "palavra_original", "substituto": "sinônimo" }
        
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
        // Fallback silencioso se a IA falhar
        return finalText;
    }
}

// ============================================================================
// 💾 GERENCIADOR DE ESTADO (PERSISTÊNCIA ISOLADA)
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
            queue: [], // Fila atual de IDs
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            quarantine: false, // Flag de parada de emergência
            currentAnnounceGuildId: null,
            privacyMode: "public",
            initiatorId: null,
            guildData: {} // Dados persistentes por servidor (blockedDMs, etc)
        };
    }

    /**
     * Carrega estado do disco ou retorna inicial.
     */
    load(initialState = null) {
        const stateToLoad = initialState || this.getInitialState();
        try {
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            // Reconverte arrays para Sets
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

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
            console.log(`[Bot ${this.botId}] ℹ️ Criando novo arquivo de estado.`);
            return this.getInitialState();
        }
    }

    /**
     * Salva o estado atual no disco (JSON).
     */
    save() {
        try {
            const serializable = {
                ...this.state,
                ignore: [...this.state.ignore],
                only: [...this.state.only],
                guildData: {}
            };
            // Serializa guildData
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

    /**
     * Modifica o estado com segurança (fila de Promises).
     */
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
// 🤖 CLASSE STEALTH BOT (LÓGICA PRINCIPAL POR INSTÂNCIA)
// ============================================================================

class StealthBot {
    constructor(token, id) {
        this.token = token;
        this.id = id; // ID numérico da instância (1, 2, 3...)
        this.stateManager = new StateManager(path.resolve(__dirname, `state_${id}.json`), id);
        
        // --- VARIÁVEIS DE CONTROLE V2 ---
        
        // Delays Iniciais (Variam por ID para evitar sincronia perfeita)
        this.currentDelayBase = (IS_LOCAL ? 2000 : 12000) + (id * 300); 
        this.currentBatchBase = IS_LOCAL ? 5 : 12;
        
        // Monitoramento de Taxas
        this.recentResults = [];    // Array circular (últimos 50)
        this.sendsThisHour = 0;     // Throughput
        this.hourlyResetTime = Date.now() + 3600000;
        this.pauseMultiplier = 1.0; // Multiplicador de pausa adaptativa
        this.batchCounter = 0;      // Contador de lotes
        
        // Watchdog
        this.lastActivityTime = Date.now();
        this.workerRunning = false;
        this.progressUpdaterHandle = null;

        // Cliente Discord.js isolado
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
        // Inicialização de Eventos
        this.setupWatchdog();
    }

    // ========================================================================
    // 🛠️ MÉTODOS AUXILIARES DA INSTÂNCIA
    // ========================================================================

    /**
     * Wait seguro com Heartbeat para o Watchdog.
     * Quebra esperas longas em pedaços de 1 min para não "congelar".
     */
    async wait(ms) {
        this.lastActivityTime = Date.now();
        
        // Se for pausa curta, espera direto
        if (ms < 120000) return new Promise(r => setTimeout(r, ms));
        
        // Pausa longa: quebra em loops
        const minutes = ms / 60000;
        const steps = Math.floor(minutes);
        const remainder = ms % 60000;

        console.log(`[Bot ${this.id}] 💤 Iniciando espera longa de ${minutes.toFixed(1)} min.`);

        for (let i = 0; i < steps; i++) {
            await new Promise(r => setTimeout(r, 60000));
            this.lastActivityTime = Date.now(); // Atualiza Heartbeat
            if ((i+1) % 5 === 0) console.log(`[Bot ${this.id}] ⏳ ... ${i+1}/${steps} min`);
        }

        if (remainder > 0) {
            await new Promise(r => setTimeout(r, remainder));
        }
    }

    /**
     * Randomiza parâmetros para evitar padrões (Anti-Fingerprinting).
     */
    randomizeParameters() {
        if (IS_LOCAL) {
            this.currentDelayBase = 2000 + Math.random() * 2000;
            this.currentBatchBase = 5 + Math.floor(Math.random() * 5);
        } else {
            // V2: Delays mais seguros (12s base + random)
            this.currentDelayBase = 12000 + Math.floor(Math.random() * 10000);
            this.currentBatchBase = 12 + Math.floor(Math.random() * 10);
        }
        console.log(`[Bot ${this.id}] 🎲 Novos Params: Delay ~${(this.currentDelayBase/1000).toFixed(1)}s | Lote ${this.currentBatchBase}`);
    }

    /**
     * Analisa taxa de rejeição (últimos 50 envios).
     * Retorna: 'normal', 'warning' ou 'critical'.
     */
    analyzeRejectionRate() {
        if (this.recentResults.length < 20) return { status: 'normal', rate: 0 };
        
        const closed = this.recentResults.filter(r => r === 'closed').length;
        const total = this.recentResults.length;
        const rate = closed / total;

        if (rate >= REJECTION_RATE_CRITICAL) return { status: 'critical', rate, closed, total };
        if (rate >= REJECTION_RATE_WARNING) return { status: 'warning', rate, closed, total };
        
        return { status: 'normal', rate, closed, total };
    }

    /**
     * Registra resultado para análise.
     */
    addResult(type) {
        this.recentResults.push(type);
        if (this.recentResults.length > REJECTION_WINDOW) this.recentResults.shift();
    }

    /**
     * Verifica limite de 180 envios/hora.
     */
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

    /**
     * Garante que os dados da guilda existam no state.
     */
    ensureGuildData(guildId) {
        const s = this.stateManager.state;
        if (!s.guildData[guildId]) {
            s.guildData[guildId] = {
                processedMembers: [],
                blockedDMs: [],     // Lista negra permanente (50007)
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

    // ========================================================================
    // 📧 SISTEMA DE BACKUP DE EMERGÊNCIA
    // ========================================================================

    async sendBackupEmail(reason, state) {
        console.log(`[Bot ${this.id}] 📧 Preparando backup de emergência. Motivo: ${reason}`);

        const guildId = state.currentAnnounceGuildId;
        const gd = guildId ? this.ensureGuildData(guildId) : null;
        
        // Coleta todos os pendentes de várias fontes (memória e disco)
        let remainingUsers = [...state.queue];
        if (gd) {
            const allPending = [
                ...state.queue,
                ...gd.pendingQueue,
                ...gd.failedQueue
            ];
            // Remove duplicatas e IDs já bloqueados
            remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
        }

        if (remainingUsers.length === 0) {
            console.log(`[Bot ${this.id}] ℹ️ Backup ignorado: Fila vazia.`);
            return;
        }

        // Cria objeto de backup completo
        const backupData = {
            source: `StealthBot_Instance_${this.id}_V2.5`,
            timestamp: new Date().toISOString(),
            reason: reason,
            text: state.text || (gd?.lastRunText || ""),
            attachments: state.attachments || (gd?.lastRunAttachments || []),
            currentAnnounceGuildId: guildId,
            remainingQueue: remainingUsers,
            stats: state.currentRunStats
        };

        const jsonContent = JSON.stringify(backupData, null, 2);

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: TARGET_EMAIL,
            subject: `🚨 Bot ${this.id} STOP: ${reason}`,
            text: `O sistema parou para proteção.\n\nMotivo: ${reason}\nRestantes: ${remainingUsers.length}\n\nCOMO RETOMAR:\n1. Baixe o anexo.\n2. Use o comando /resume e anexe este arquivo.\n\nAtenciosamente,\nSistema V2.5`,
            attachments: [{ 
                filename: `backup_bot${this.id}_${Date.now()}.json`, 
                content: jsonContent 
            }]
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`[Bot ${this.id}] ✅ E-mail de backup enviado com sucesso.`);
        } catch (error) {
            console.error(`[Bot ${this.id}] ❌ Falha crítica no envio de e-mail:`, error);
        }
    }

    // ========================================================================
    // 📨 LÓGICA DE ENVIO INDIVIDUAL
    // ========================================================================

    async sendStealthDM(user, rawText, attachments) {
        this.lastActivityTime = Date.now(); // Heartbeat

        // 1. Tenta criar/recuperar canal DM
        let dmChannel;
        try {
            if (user.dmChannel) dmChannel = user.dmChannel;
            else dmChannel = await user.createDM();
        } catch (e) { 
            return { success: false, reason: "closed" }; // Provavelmente DM fechada
        }

        // 2. Aplica IA e Variação
        let finalContent = rawText;
        if (rawText) {
            const userDisplay = user.globalName || user.username || "amigo";
            finalContent = await getAiVariation(rawText, userDisplay);
        }

        // 3. Simula Digitação (Humanização)
        try {
            const shouldType = Math.random() > 0.25; // 75% das vezes digita
            if (shouldType && finalContent) {
                await dmChannel.sendTyping();
                const typeTime = calculateTypingTime(finalContent);
                await this.wait(typeTime);
            } else {
                await this.wait(1000 + Math.random() * 2000);
            }
        } catch (e) { /* Ignora erro de typing */ }

        // 4. Monta Payload
        const payload = {};
        if (finalContent) payload.content = finalContent;
        if (attachments && attachments.length > 0) payload.files = attachments;
        if (!payload.content && !payload.files) return { success: false, reason: "empty" };

        // 5. Tentativa de Envio com Retries
        for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
            try {
                await dmChannel.send(payload);
                console.log(`[Bot ${this.id}] ✅ Enviado para ${user.tag}`);
                return { success: true };
            } catch (err) {
                const errMsg = (err.message || "").toLowerCase();
                const code = err.code || 0;

                // 🚨 FLAG CRÍTICA: SPAM DETECTADO
                if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                    console.error(`[Bot ${this.id}] 🚨 ALERTA CRÍTICO: SPAM FLAG (40003)`);
                    await this.stateManager.modify(s => s.quarantine = true);
                    return { success: false, reason: "quarantine" };
                }

                // DM Fechada / Bloqueada
                if (code === 50007 || code === 50001) {
                    return { success: false, reason: "closed" };
                }

                // Rate Limit Temporário (Backoff)
                if (err.retry_after || code === 20016) {
                    const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;
                    
                    if (waitTime > 3600000) { // > 1 hora = aborta
                        console.error(`[Bot ${this.id}] 🚨 Rate Limit Extremo (${(waitTime/60000).toFixed(0)}m). Quarentena.`);
                        await this.stateManager.modify(s => s.quarantine = true);
                        return { success: false, reason: "quarantine" };
                    }

                    console.warn(`[Bot ${this.id}] ⏳ Rate Limit. Esperando ${waitTime/1000}s.`);
                    this.currentDelayBase += 5000; // Penalidade no delay base
                    await this.wait(waitTime);
                    continue; // Tenta de novo
                }

                // Erro genérico de rede
                const backoff = 5000 * attempt;
                console.error(`[Bot ${this.id}] ❌ Erro envio (${attempt}): ${errMsg}. Retry em ${backoff}ms.`);
                if (attempt < RETRY_LIMIT) await this.wait(backoff);
            }
        }
        return { success: false, reason: "fail" };
    }

    // ========================================================================
    // 🏭 WORKER LOOP (O CÉREBRO V2.5)
    // ========================================================================

    async workerLoop() {
        console.log(`[Bot ${this.id}] 🚀 Worker Iniciado - Sistema V2.5 Ativo`);
        const state = this.stateManager.state;
        const guildId = state.currentAnnounceGuildId;

        // Validação inicial
        if (!guildId) {
            console.error(`[Bot ${this.id}] ⚠️ Worker sem guilda definida.`);
            await this.stateManager.modify(s => s.active = false);
            return;
        }

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) {
            console.error(`[Bot ${this.id}] ❌ Guilda não encontrada.`);
            await this.stateManager.modify(s => s.active = false);
            return;
        }

        const gd = this.ensureGuildData(guildId);
        
        // Variáveis locais do loop
        let sentInBatch = 0;
        let currentBatchSize = this.currentBatchBase;
        let consecutiveClosedCount = 0;
        this.batchCounter = 0;

        try {
            while (state.active && state.queue.length > 0) {
                this.lastActivityTime = Date.now(); // Heartbeat principal

                // -----------------------------------------------------------
                // 🛑 LÓGICA DE PAUSAS PROGRESSIVAS (ENTRE LOTES)
                // -----------------------------------------------------------
                if (sentInBatch >= currentBatchSize) {
                    this.batchCounter++;
                    const analysis = this.analyzeRejectionRate();
                    
                    let basePause;

                    if (IS_LOCAL) {
                        basePause = 3000; // 3s local
                    } else {
                        // Lógica Adaptativa V2
                        if (analysis.status === 'critical') {
                            console.warn(`[Bot ${this.id}] 🚨 TAXA CRÍTICA (${(analysis.rate * 100).toFixed(1)}%). Aumentando pausas.`);
                            basePause = EXTENDED_PAUSE_MS; // 15 min
                            this.pauseMultiplier = Math.min(this.pauseMultiplier * 1.5, 3.0);
                        } else if (analysis.status === 'warning') {
                            console.warn(`[Bot ${this.id}] ⚠️ TAXA ELEVADA. Modo cautela.`);
                            basePause = MAX_BATCH_PAUSE_MS; // 8 min
                            this.pauseMultiplier = Math.min(this.pauseMultiplier * 1.2, 2.0);
                        } else {
                            // Escalonamento Normal
                            if (this.batchCounter <= 2) basePause = MIN_BATCH_PAUSE_MS; // 3 min
                            else if (this.batchCounter <= 5) basePause = (MIN_BATCH_PAUSE_MS + MAX_BATCH_PAUSE_MS) / 2;
                            else basePause = MAX_BATCH_PAUSE_MS; // 8 min
                            
                            this.pauseMultiplier = Math.max(this.pauseMultiplier * 0.95, 1.0); // Recuperação lenta
                        }
                    }

                    // Aplica variância natural
                    const variance = basePause * 0.3; 
                    let pauseDuration = (basePause * this.pauseMultiplier) + (Math.random() * variance - variance/2);
                    pauseDuration = Math.min(pauseDuration, ABSOLUTE_MAX_PAUSE_MS);

                    console.log(`[Bot ${this.id}] 🔄 Lote ${this.batchCounter} fim. Pausa: ${(pauseDuration/60000).toFixed(1)} min.`);
                    
                    this.stateManager.forceSave();
                    await this.updateProgressEmbed();
                    
                    await this.wait(pauseDuration); // Pausa longa segura
                    this.randomizeParameters(); // Troca delays base

                    // Verifica se foi parado durante a pausa
                    if (!state.active) break;
                    
                    // Reseta lote
                    sentInBatch = 0;
                    currentBatchSize = this.currentBatchBase + (Math.floor(Math.random() * 5));
                }

                // -----------------------------------------------------------
                // 👤 PROCESSAMENTO DO USUÁRIO
                // -----------------------------------------------------------
                
                const userId = state.queue.shift();
                await this.stateManager.modify(() => {}); // Trigger save check

                // 1. Verifica se membro ainda está na guilda (fetch)
                let member;
                try { 
                    member = await guild.members.fetch(userId).catch(() => null); 
                } catch(e) {}

                if (!member) {
                    // Usuário saiu do servidor - Pula e registra
                    await this.stateManager.modify(s => {
                         const g = this.ensureGuildData(guildId);
                         if (!g.processedMembers.includes(userId)) g.processedMembers.push(userId);
                    });
                    consecutiveClosedCount = 0; // Não conta como falha
                    continue;
                }

                // 2. Verifica Bloqueios Anteriores
                if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                    continue; // Pula silenciosamente
                }

                // 3. Resolve Objeto User
                let user = this.client.users.cache.get(userId);
                if (!user) {
                    try { user = await this.client.users.fetch(userId); }
                    catch (e) { continue; }
                }

                // 4. Filtro de Segurança (Bot/Fake)
                if (user.bot || isSuspiciousAccount(user)) {
                    console.log(`[Bot ${this.id}] 🚫 Ignorado (Bot/Suspeito): ${user.tag}`);
                    continue;
                }

                // 5. Verifica Throughput (180/h)
                if (sentInBatch > 0 && sentInBatch % HOURLY_CHECK_INTERVAL === 0) {
                    const limitCheck = this.checkHourlyLimit();
                    if (limitCheck.exceeded) {
                        const waitMin = (limitCheck.waitTime / 60000).toFixed(1);
                        console.warn(`[Bot ${this.id}] ⏱️ Limite horário (180/h) atingido. Aguardando ${waitMin} min...`);
                        this.stateManager.forceSave();
                        await this.updateProgressEmbed();
                        await this.wait(limitCheck.waitTime);
                    }
                }

                // 🚀 ENVIO REAL
                const result = await this.sendStealthDM(user, state.text, state.attachments);

                // 📊 Registro de Resultado (Analítico)
                if (result.success) this.addResult('success');
                else if (result.reason === 'closed') this.addResult('closed');
                else this.addResult('fail');

                // 💾 Persistência de Resultado
                await this.stateManager.modify(s => {
                    const g = this.ensureGuildData(guildId);
                    
                    if (result.success) {
                        s.currentRunStats.success++;
                        consecutiveClosedCount = 0; // ✅ SUCESSO RESETA CIRCUIT BREAKER
                        // Remove da falha se estiver lá
                        const idx = g.failedQueue.indexOf(userId);
                        if (idx > -1) g.failedQueue.splice(idx, 1);

                    } else if (result.reason === 'closed') {
                        s.currentRunStats.closed++;
                        consecutiveClosedCount++; // ⚠️ FALHA CONTA CIRCUIT BREAKER
                        if (!g.blockedDMs.includes(userId)) g.blockedDMs.push(userId); // Bloqueio permanente

                    } else if (result.reason === 'quarantine') {
                        s.active = false;
                        s.quarantine = true;

                    } else { // 'fail' genérico
                        s.currentRunStats.fail++;
                        consecutiveClosedCount = 0;
                        if (!g.failedQueue.includes(userId)) g.failedQueue.push(userId);
                    }

                    if (!g.processedMembers.includes(userId)) g.processedMembers.push(userId);
                });

                // -----------------------------------------------------------
                // ⚡ CIRCUIT BREAKER (DMs FECHADAS)
                // -----------------------------------------------------------
                if (consecutiveClosedCount >= MAX_CONSECUTIVE_CLOSED) {
                    console.warn(`[Bot ${this.id}] 🛡️ ALERTA: ${consecutiveClosedCount} DMs fechadas seguidas. Resfriando ${CLOSED_DM_COOLING_MS/60000} min...`);
                    this.stateManager.forceSave();
                    await this.updateProgressEmbed();
                    
                    await this.wait(CLOSED_DM_COOLING_MS); 
                    
                    consecutiveClosedCount = 0; // Reseta após castigo
                    this.randomizeParameters(); 
                    console.log(`[Bot ${this.id}] ❄️ Resfriamento concluído.`);
                }

                // Sai se entrou em quarentena
                if (state.quarantine) {
                    await this.sendBackupEmail("Quarentena Detectada (API Flag 40003)", state);
                    break;
                }

                await this.updateProgressEmbed().catch(() => {});

                // -----------------------------------------------------------
                // 🎲 DELAYS PÓS-ENVIO (ADAPTATIVOS)
                // -----------------------------------------------------------
                if (result.success) {
                    // Delay Normal
                    let d = this.currentDelayBase + Math.floor(Math.random() * 8000);
                    
                    // Delay Extra Longo (15% chance)
                    if (Math.random() < EXTRA_LONG_DELAY_CHANCE) {
                        const extra = IS_LOCAL ? 5000 : EXTRA_LONG_DELAY_MS + Math.floor(Math.random() * 15000);
                        d += extra;
                        console.log(`[Bot ${this.id}] 💭 Pausa natural... +${(extra/1000).toFixed(0)}s`);
                    }
                    await this.wait(d);
                } else {
                    // Penalidade Adaptativa (Se falhou, espera mais)
                    let penalty;
                    if (result.reason === 'closed') {
                        const multiplier = Math.min(consecutiveClosedCount, 5); 
                        penalty = IS_LOCAL ? 1000 : 5000 * multiplier; // 5s, 10s, 15s...
                    } else {
                        penalty = IS_LOCAL ? 2000 : 20000;
                    }
                    await this.wait(penalty);
                }
                
                sentInBatch++;
            } // Fim do While

            // Finalização limpa
            if (state.queue.length === 0 && state.active) {
                console.log(`[Bot ${this.id}] ✅ Fim da Fila.`);
                await this.finalizeSending();
            }

        } catch (err) {
            console.error(`[Bot ${this.id}] 💥 Erro Crítico no Worker:`, err);
            await this.sendBackupEmail(`Erro Crítico no Worker: ${err.message}`, state);
        } finally {
            this.workerRunning = false;
            const finalState = this.stateManager.state;
            // Se parou com fila e não foi sucesso completo, faz backup
            if (finalState.queue.length > 0 && (!finalState.active || finalState.quarantine)) {
                console.log(`[Bot ${this.id}] ⚠️ Worker interrompido.`);
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
            this.stateManager.forceSave();
        });
    }

    // ========================================================================
    // 📊 FINALIZAÇÃO E UPDATE DE UI
    // ========================================================================

    async finalizeSending() {
        this.stopProgressUpdater();
        const s = this.stateManager.state;
        const guildId = s.currentAnnounceGuildId;

        // Move fila restante para pending se necessário
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
        const embedColor = remaining === 0 && !s.quarantine ? 0x00FF00 : 0xFF0000;

        const embed = new EmbedBuilder()
            .setTitle(`📬 Relatório Final (Bot ${this.id})`)
            .setColor(embedColor)
            .addFields(
                { name: "✅ Sucesso", value: `${s.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${s.currentRunStats.fail}`, inline: true },
                { name: "🚫 DMs Fechadas", value: `${s.currentRunStats.closed}`, inline: true },
                { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
            );

        if (s.quarantine) {
            embed.addFields({ name: "🚨 STATUS", value: "QUARENTENA/STOP (Backup Enviado)", inline: false });
        }

        const finalText = remaining === 0 ? "✅ Campanha finalizada!" : `⏸️ Parado. Restam ${remaining}.`;

        // Atualiza a mensagem original
        if (s.progressMessageRef) {
            try {
                const ch = await this.client.channels.fetch(s.progressMessageRef.channelId);
                const msg = await ch.messages.fetch(s.progressMessageRef.messageId);
                
                // Se for modo privado (Slash), tenta DM do user também
                if (s.privacyMode === 'private' && s.initiatorId) {
                     const user = await this.client.users.fetch(s.initiatorId);
                     try { await user.send({ content: finalText, embeds: [embed] }); } catch(e){}
                } else {
                     await msg.edit({ content: finalText, embeds: [embed] });
                }
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
            
            const rate = this.analyzeRejectionRate().rate * 100;
            const embed = new EmbedBuilder()
                .setTitle(`📨 Bot ${this.id}: Enviando...`)
                .setColor("#00AEEF")
                .setDescription(`Fila: ${s.queue.length} | Sucesso: ${s.currentRunStats.success} | Rejeição: ${rate.toFixed(1)}%`);
                
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
        if (this.progressUpdaterHandle) { 
            clearInterval(this.progressUpdaterHandle); 
            this.progressUpdaterHandle = null; 
        }
    }

    // ========================================================================
    // 🕹️ LÓGICA DE COMANDOS (ANNOUNCE, RESUME, ETC)
    // ========================================================================

    async handleAnnounce(ctx, text, attachmentUrl, filtersStr) {
        const s = this.stateManager.state;
        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;
        
        // Verifica se já está rodando
        if (s.active) {
            const msg = "❌ Bot ocupado com outro envio.";
            return isSlash ? ctx.reply({content: msg, ephemeral: true}) : ctx.reply(msg);
        }

        const guildId = ctx.guild.id;
        const gd = this.ensureGuildData(guildId);
        
        // Parseia Texto e Filtros
        const parsed = parseSelectors(filtersStr || "");
        let messageText = parsed.cleaned || text || "";
        
        // Formata Slash commands para manter quebras de linha
        if (isSlash && messageText) {
            messageText = messageText.replace(/ {2,}/g, '\n\n')
                                     .replace(/ ([*•+]) /g, '\n$1 ')
                                     .replace(/\n /g, '\n');
        }

        if (!messageText && !attachmentUrl) {
            return isSlash ? ctx.reply({content: "❌ Texto ou anexo obrigatório.", ephemeral: true}) : ctx.reply("❌ Texto ou anexo obrigatório.");
        }

        // Verifica pendentes
        const totalRemaining = gd.pendingQueue.length + gd.failedQueue.length;
        if (totalRemaining > 0 && !parsed.hasForce) {
            const msg = `⚠️ Há **${totalRemaining}** pendentes. Use \`/resume\` ou adicione \`force\` nos filtros.`;
            return isSlash ? ctx.reply({content: msg, ephemeral: true}) : ctx.reply(msg);
        }

        if (parsed.hasForce) {
            await this.stateManager.modify(st => {
                const g = this.ensureGuildData(guildId);
                g.pendingQueue = [];
                g.failedQueue = [];
            });
        }

        // Busca Membros
        if (isSlash) await ctx.deferReply({ ephemeral: true });
        
        const members = await ctx.guild.members.fetch(); // Fetch fresco
        const queue = [];
        
        members.forEach(m => {
            if (m.user.bot) return;
            if (gd.blockedDMs.includes(m.id)) return; // Ignora bloqueados
            if (parsed.only.size > 0 && !parsed.only.has(m.id)) return;
            if (parsed.ignore.has(m.id)) return;
            queue.push(m.id);
        });

        if (queue.length === 0) {
            const msg = "❌ Nenhum membro qualificado encontrado.";
            return isSlash ? ctx.editReply(msg) : ctx.reply(msg);
        }

        // Inicializa Estado
        await this.stateManager.modify(st => {
            st.active = true;
            st.quarantine = false;
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

        // Feedback Inicial
        const infoMsg = `🚀 [Bot ${this.id}] Iniciando envio para **${queue.length}** membros...`;
        
        if (isSlash) {
            // No Slash, envia painel na DM do admin
            try {
                const user = await ctx.user.createDM();
                const embed = new EmbedBuilder().setTitle(`Bot ${this.id} Iniciado`).setDescription("Acompanhe o progresso aqui.");
                const dmMsg = await user.send({ content: infoMsg, embeds: [embed] });
                
                await this.stateManager.modify(st => {
                    st.progressMessageRef = { channelId: dmMsg.channel.id, messageId: dmMsg.id };
                });
                await ctx.editReply("✅ Envio iniciado! Verifique suas DMs.");
            } catch (e) {
                await ctx.editReply("❌ Não consegui enviar DM. Verifique suas configurações.");
                await this.stateManager.modify(s => s.active = false);
                return;
            }
        } else {
            // No Prefix, painel no canal
            const msg = await ctx.reply(infoMsg);
            await this.stateManager.modify(st => {
                st.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id };
            });
        }

        this.startProgressUpdater();
        this.startWorker();
    }

    async handleResume(ctx, attachmentUrl) {
        if (this.stateManager.state.active) return ctx.reply("⚠️ Já ativo.");

        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

        // Se tem anexo, carrega estado externo
        if (attachmentUrl) {
            const jsonResult = await readAttachmentJSON(attachmentUrl);
            if (!jsonResult.success) return ctx.reply(jsonResult.error);
            // Mescla estado
            await this.stateManager.modify(s => Object.assign(s, jsonResult.state));
        }

        const s = this.stateManager.state;
        const gd = this.ensureGuildData(ctx.guild.id);

        // Reconstrói fila (Queue + Pending + Failed) - Bloqueados
        const allIds = [...new Set([
            ...s.queue,
            ...gd.pendingQueue,
            ...gd.failedQueue
        ])].filter(id => !gd.blockedDMs.includes(id));

        if (allIds.length === 0) return ctx.reply("✅ Nada para retomar.");

        // Recupera texto/anexo
        const text = s.text || gd.lastRunText;
        const attach = (s.attachments && s.attachments.length) ? s.attachments : gd.lastRunAttachments;

        await this.stateManager.modify(st => {
            st.active = true;
            st.quarantine = false;
            st.currentAnnounceGuildId = ctx.guild.id;
            st.queue = allIds;
            st.text = text;
            st.attachments = attach || [];
            st.currentRunStats = { success: 0, fail: 0, closed: 0 };
            st.initiatorId = initiatorId;
            st.privacyMode = isSlash ? 'private' : 'public';
            
            // Limpa pendências pois foram movidas para queue
            const g = this.ensureGuildData(ctx.guild.id);
            g.pendingQueue = [];
            g.failedQueue = [];
        });

        const infoMsg = `🔄 [Bot ${this.id}] Retomando para **${allIds.length}** membros...`;

        if (isSlash) {
            await ctx.deferReply({ephemeral: true});
            try {
                const user = await ctx.user.createDM();
                const embed = new EmbedBuilder().setTitle(`Bot ${this.id} Retomado`).setDescription("Aguarde...");
                const dmMsg = await user.send({ content: infoMsg, embeds: [embed] });
                
                await this.stateManager.modify(st => {
                    st.progressMessageRef = { channelId: dmMsg.channel.id, messageId: dmMsg.id };
                });
                await ctx.editReply("✅ Retomado! Verifique DM.");
            } catch(e) {
                await ctx.editReply("❌ Erro DM.");
            }
        } else {
            const msg = await ctx.reply(infoMsg);
            await this.stateManager.modify(st => {
                st.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id };
            });
        }

        this.startProgressUpdater();
        this.startWorker();
    }

    // ========================================================================
    // 🔌 STARTUP & WATCHDOG
    // ========================================================================

    setupWatchdog() {
        // Monitora congelamento do processo
        setInterval(() => {
            const inactiveTime = Date.now() - this.lastActivityTime;
            if (inactiveTime > INACTIVITY_THRESHOLD) {
                console.error(`[Bot ${this.id}] 🚨 Watchdog: Inatividade > 30min! Salvando e Resetando.`);
                this.stateManager.forceSave();
                if (this.stateManager.state.active) {
                    this.sendBackupEmail("Watchdog Freeze Detectado", this.stateManager.state);
                }
                // Em um ambiente real, process.exit(1) reiniciaria o container
            }
        }, 60000);
    }

    async registerSlashCommands() {
        const commands = [
            new SlashCommandBuilder().setName('announce').setDescription('Iniciar Envio (Invisível)')
                .addStringOption(o => o.setName('texto').setDescription('Mensagem').setRequired(true))
                .addAttachmentOption(o => o.setName('anexo').setDescription('Imagem opcional'))
                .addStringOption(o => o.setName('filtros').setDescription('Ex: force, +{ID}')),
            new SlashCommandBuilder().setName('resume').setDescription('Retomar Envio (Invisível)')
                .addAttachmentOption(o => o.setName('arquivo').setDescription('Arquivo JSON de Backup')),
            new SlashCommandBuilder().setName('stop').setDescription('Parar Envio (Invisível)'),
            new SlashCommandBuilder().setName('status').setDescription('Ver Status (Invisível)')
        ];

        const rest = new REST({ version: '10' }).setToken(this.token);
        try {
            console.log(`[Bot ${this.id}] Registrando comandos Slash...`);
            await rest.put(Routes.applicationCommands(this.client.user.id), { body: commands });
        } catch (e) {
            console.error(`[Bot ${this.id}] ❌ Erro Slash Commands:`, e);
        }
    }

    async start() {
        // EVENTO READY
        this.client.on('ready', async () => {
            console.log(`✅ [Bot ${this.id}] Online como: ${this.client.user.tag}`);
            await this.registerSlashCommands();
            
            // Se estava rodando antes de cair, retoma worker
            if (this.stateManager.state.active) {
                console.log(`[Bot ${this.id}] 🔄 Retomando worker após reinício...`);
                this.startWorker();
            }
        });

        // HANDLER SLASH COMMANDS (/)
        this.client.on('interactionCreate', async interaction => {
            if (!interaction.isChatInputCommand()) return;
            
            // Check Admin
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: "⛔ Apenas Administradores.", ephemeral: true });
            }

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
                
                } else if (commandName === 'stop') {
                    await interaction.deferReply({ephemeral: true});
                    await this.stateManager.modify(s => s.active = false);
                    await this.sendBackupEmail("Stop Manual Slash", this.stateManager.state);
                    await interaction.editReply("🛑 Parado. Backup enviado por e-mail.");
                
                } else if (commandName === 'status') {
                    const s = this.stateManager.state;
                    const gd = s.currentAnnounceGuildId ? this.ensureGuildData(s.currentAnnounceGuildId) : {};
                    const rate = this.analyzeRejectionRate().rate * 100;
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`📊 Status Bot ${this.id}`)
                        .setColor(s.active ? 0x00FF00 : 0x808080)
                        .addFields(
                            { name: "Estado", value: s.active ? "🟢 Ativo" : "⚪ Parado", inline: true },
                            { name: "Fila", value: `${s.queue.length}`, inline: true },
                            { name: "Rejeição (50)", value: `${rate.toFixed(1)}%`, inline: true },
                            { name: "Sucesso Hoje", value: `${s.currentRunStats.success}`, inline: true }
                        );
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            } catch (e) {
                console.error(`[Bot ${this.id}] Erro Slash:`, e);
            }
        });

        // HANDLER LEGACY COMMANDS (!)
        this.client.on("messageCreate", async (message) => {
            if (message.author.bot || !message.guild) return;
            if (!message.content.startsWith('!')) return;
            
            if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;

            const args = message.content.slice(1).trim().split(/ +/);
            const cmd = args.shift().toLowerCase();
            const fullContent = message.content.slice(cmd.length + 2).trim(); // Remove '!cmd '

            try {
                if (cmd === 'announce') {
                    const attachment = message.attachments.first();
                    await this.handleAnnounce(message, fullContent, attachment ? attachment.url : null, fullContent);
                
                } else if (cmd === 'resume') {
                    const attachment = message.attachments.first();
                    await this.handleResume(message, attachment ? attachment.url : null);
                
                } else if (cmd === 'stop') {
                    await this.stateManager.modify(s => s.active = false);
                    await this.sendBackupEmail("Stop Manual Legacy", this.stateManager.state);
                    message.reply("🛑 Parado (Backup enviado).");
                
                } else if (cmd === 'status') {
                    const s = this.stateManager.state;
                    const rate = this.analyzeRejectionRate().rate * 100;
                    message.reply(`📊 **Bot ${this.id}**: ${s.active ? 'Ativo' : 'Parado'} | Fila: ${s.queue.length} | Rejeição: ${rate.toFixed(1)}%`);
                }
            } catch (e) {
                console.error(`[Bot ${this.id}] Erro Legacy:`, e);
            }
        });

        // Login
        await this.client.login(this.token);
    }
}

// ============================================================================
// 🏭 INICIALIZADOR DE INSTÂNCIAS (MULTI-TOKEN)
// ============================================================================

const bots = [];

function loadBots() {
    let index = 1;
    // Loop infinito procurando tokens no .env (DISCORD_TOKEN, DISCORD_TOKEN2...)
    while (true) {
        const envKey = index === 1 ? 'DISCORD_TOKEN' : `DISCORD_TOKEN${index}`;
        const token = process.env[envKey];
        
        if (!token) break; // Acabaram os tokens

        console.log(`🔌 [System] Inicializando instância ${index}...`);
        const bot = new StealthBot(token, index);
        bot.start();
        bots.push(bot);
        index++;
    }

    if (bots.length === 0) {
        console.error("❌ ERRO FATAL: Nenhum token encontrado no .env");
        process.exit(1);
    }
}

// ============================================================================
// 🌍 SERVIDOR HTTP (MONITORAMENTO & ANTI-FREEZE)
// ============================================================================

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    const uptime = process.uptime();
    const botStatus = bots.map(b => ({
        id: b.id,
        active: b.stateManager.state.active,
        queue: b.stateManager.state.queue.length,
        success: b.stateManager.state.currentRunStats.success
    }));

    const status = {
        status: "online",
        system: "Anti-Quarantine V2.5",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        bots: botStatus,
        timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
});

server.listen(PORT, () => {
    console.log(`\n🛡️  ANNOUNCE BOT V2.5 - SERVER ONLINE NA PORTA ${PORT}`);
    console.log(`🛡️  Modo: ${IS_CLOUD ? 'NUVEM (Stealth)' : 'LOCAL (Debug)'}`);
    console.log(`🛡️  IA: ${genAI ? 'Ativa (Gemini)' : 'Inativa'}`);
    console.log(`-----------------------------------------------------`);
    loadBots();
});

// ============================================================================
// 🛑 SHUTDOWN HANDLERS (GRACEFUL EXIT)
// ============================================================================

process.on('SIGINT', async () => {
    console.log("\n🛑 SIGINT Recebido. Salvando estados e encerrando...");
    bots.forEach(b => b.stateManager.forceSave());
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log("\n🛑 SIGTERM Recebido. Encerrando container...");
    bots.forEach(b => b.stateManager.forceSave());
    process.exit(0);
});

process.on("unhandledRejection", (err) => {
    console.error("❌ Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    bots.forEach(b => b.stateManager.forceSave());
    // Em produção crítica, pode-se optar por não sair, mas é arriscado
    // process.exit(1); 
});