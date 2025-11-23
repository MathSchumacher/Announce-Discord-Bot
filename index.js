require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https"); // Necessário para baixar o anexo JSON
const nodemailer = require("nodemailer"); // Necessário para enviar o backup por e-mail
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================================
// CONFIGURAÇÃO DA IA (GEMINI)
// ============================================================================

const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) 
    : null;

// Usa o modelo Flash 2.5 (Mais rápido e atual) ou fallback para Pro se der erro
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;

// ============================================================================
// VARIÁVEL DE AMBIENTE (IS_LOCAL)
// ============================================================================

// Detecta se está rodando em nuvem (Heroku, Railway, etc) ou Local
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;

console.log(`🌍 Ambiente Detectado: ${IS_LOCAL ? 'LOCAL (PC)' : 'NUVEM'}`);

// ============================================================================
// CONFIGURAÇÕES GERAIS E CONSTANTES (MODO STEALTH ATIVADO)
// ============================================================================

const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// === SEGURANÇA: VALORES AUMENTADOS PARA EVITAR DETECÇÃO ===
let currentDelayBase = 25000; // Aumentado para 25s base
const DELAY_RANDOM_MS = 15000; // Variação de até +15s
let currentBatchBase = 12; // Lotes menores (12 msgs) são mais seguros
const BATCH_VARIANCE = 4; // Variação do lote (8 a 16)
const MIN_BATCH_PAUSE_MS = 12 * 60 * 1000; // Pausa mínima de 12 minutos
const MAX_BATCH_PAUSE_MS = 25 * 60 * 1000; // Pausa máxima de 25 minutos

// === FILTROS DE SEGURANÇA DE CONTA (NOVO) ===
const MIN_ACCOUNT_AGE_DAYS = 30; // Ignora contas com menos de 30 dias (anti-armadilha)
const IGNORE_NO_AVATAR = true;   // Ignora usuários sem foto de perfil (geralmente bots/spam traps)

// === COOLDOWN DINÂMICO POR SERVIDOR ===
const GUILD_COOLDOWN_MIN_HOURS = 6;
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 2000; // Adiciona 2s de cooldown para cada usuário enviado

// === OTIMIZAÇÃO E PROTEÇÃO CONTRA SOFT-BAN ===
const SAVE_THRESHOLD = 5; // Salva o arquivo JSON a cada 5 alterações de estado
const MEMBER_CACHE_TTL = 5 * 60 * 1000; // Cache de lista de membros por 5 minutos
const SOFT_BAN_THRESHOLD = 0.4; // Se 40% das tentativas falharem, ativa o modo de emergência
const SOFT_BAN_MIN_SAMPLES = 10; // Mínimo de 10 tentativas para calcular a taxa de falha

// ============================================================================
// SERVIÇO DE E-MAIL (BACKUP DE EMERGÊNCIA)
// ============================================================================

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Seu e-mail (configurado no .env)
        pass: process.env.EMAIL_PASS  // Sua senha de app (configurada no .env)
    }
});

/**
 * Envia um e-mail com o estado atual do bot em anexo (JSON).
 * Acionado em caso de Quarentena, Erro Crítico ou Shutdown.
 */
async function sendBackupEmail(reason, state) {
    console.log(`📧 Iniciando processo de backup por e-mail. Motivo: ${reason}`);
    
    const guildId = state.currentAnnounceGuildId;
    let remainingUsers = [...state.queue];
    
    // Se houver um envio ativo, tenta coletar todos os usuários pendentes de todas as filas
    if (guildId && state.guildData[guildId]) {
        const gd = state.guildData[guildId];
        
        // Combina a fila atual, a fila de pendentes e a fila de falhas
        const allPending = [
            ...state.queue,
            ...gd.pendingQueue,
            ...gd.failedQueue
        ];
        
        // Remove duplicatas e remove usuários que estão na lista de bloqueio
        remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
    }

    // Se não sobrar ninguém para enviar, não faz sentido mandar o e-mail
    if (remainingUsers.length === 0) {
        console.log("📧 Backup de e-mail ignorado: Nenhum usuário válido restante na fila.");
        return;
    }

    // Cria o objeto de backup
    const backupData = {
        source: "Bot_Stealth_System_Full",
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
        subject: `🚨 Bot Security Alert: ${reason}`,
        text: `O sistema de envio foi interrompido para proteção.\n\n` +
              `📌 Motivo: ${reason}\n` +
              `👥 Usuários Restantes: ${remainingUsers.length}\n\n` +
              `COMO RETOMAR:\n` +
              `1. Baixe o arquivo JSON anexado.\n` +
              `2. Vá ao servidor Discord correto.\n` +
              `3. Use o comando !resume e anexe este arquivo na mensagem.`,
        attachments: [
            {
                filename: `resume_stealth_${Date.now()}.json`,
                content: jsonContent
            }
        ]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("✅ E-mail de backup enviado com sucesso!");
    } catch (error) {
        console.error("❌ FALHA CRÍTICA ao enviar e-mail de backup:", error);
    }
}

// ============================================================================
// GERENCIADOR DE ESTADO (STATE MANAGER)
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
            guildData: {} // Armazena dados específicos de cada servidor
        };
    }

    load(initialState = null) {
        const stateToLoad = initialState || this.getInitialState();
        
        try {
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            // Reconverte Arrays para Sets (filtros de comando)
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // CORREÇÃO IMPORTANTE: Carrega blockedDMs e processedMembers como ARRAYS para evitar erro .includes()
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = Array.isArray(gd.processedMembers) ? gd.processedMembers : [];
                gd.blockedDMs = Array.isArray(gd.blockedDMs) ? gd.blockedDMs : []; // Carrega como Array
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
                gd.lastRunText = gd.lastRunText || "";
                gd.lastRunAttachments = Array.isArray(gd.lastRunAttachments) ? gd.lastRunAttachments : [];
            }

            console.log(`✅ Estado ${initialState ? "importado do anexo" : "carregado do disco"} com sucesso.`);
            return loaded;
        } catch (e) {
            if (initialState) {
                console.error("❌ Erro ao processar o JSON anexado:", e);
                return null;
            }
            console.log("ℹ️ Nenhum estado anterior encontrado ou arquivo corrompido. Iniciando limpo.");
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
                    // Já são arrays, spread para garantir cópia limpa
                    processedMembers: [...data.processedMembers],
                    blockedDMs: [...data.blockedDMs] 
                };
            }

            fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
            this.unsavedChanges = 0;
        } catch (e) {
            console.error("❌ Erro ao salvar estado no disco:", e);
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
        const saveOnExit = async (signal) => {
            console.log(`\n🛑 Recebido sinal de encerramento (${signal})...`);
            
            // 1. Salva estado local
            this.forceSave();
            
            // 2. Verifica se precisa enviar backup por e-mail
            const hasActiveQueue = this.state.active && this.state.queue.length > 0;
            const hasPendingQueue = this.state.currentAnnounceGuildId && 
                                    this.state.guildData[this.state.currentAnnounceGuildId]?.pendingQueue.length > 0;

            if (hasActiveQueue || hasPendingQueue) {
                console.log("⚠️ Detectado desligamento com itens na fila. Enviando backup...");
                await sendBackupEmail(`Shutdown do Servidor (${signal})`, this.state);
            }
            
            console.log("👋 Encerrando processo.");
            process.exit(0);
        };

        process.on('SIGINT', () => saveOnExit('SIGINT'));
        process.on('SIGTERM', () => saveOnExit('SIGTERM'));
    }
}

const stateManager = new StateManager(STATE_FILE);

// ============================================================================
// CLIENTE DISCORD
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
// UTILITÁRIOS
// ============================================================================

const wait = ms => new Promise(r => setTimeout(r, ms));

function randomizeParameters() {
    // Humanizer: Muda o delay base para não parecer robô
    // Se estiver rodando LOCAL, usa delays rápidos. Se NUVEM, delays longos.
    const minDelay = IS_LOCAL ? 2000 : 22000;
    const maxDelay = IS_LOCAL ? 5000 : 35000;
    
    currentDelayBase = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    
    // Lotes variam
    currentBatchBase = Math.floor(Math.random() * (15 - 8 + 1)) + 8; 
    
    console.log(`🎲 Humanizer: Novo Ritmo -> Delay ~${(currentDelayBase/1000).toFixed(1)}s | Lote ~${currentBatchBase} msgs`);
}

function getNextBatchSize() {
    const min = Math.max(1, currentBatchBase - BATCH_VARIANCE);
    const max = currentBatchBase + BATCH_VARIANCE;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateTypingTime(text) {
    if (!text) return 1500;
    const charactersPerSecond = 15;
    const ms = (text.length / charactersPerSecond) * 1000;
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
    const finalText = hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned;
    return { cleaned: finalText, ignore, only, hasForce };
}

function getVariedText(text) {
    if (!text || text.includes("http")) return text || "";
    const invisibleChars = ["\u200B", "\u200C", "\u200D", "\u2060"];
    const randomChar = invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
    return `${text}${randomChar}`;
}

function validateAttachments(attachments) {
    const MAX_SIZE = 8 * 1024 * 1024; 
    const ALLOWED = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.pdf', '.webm'];
    for (const att of attachments) {
        if (att.size > MAX_SIZE) return { valid: false, error: `❌ Arquivo "${att.name}" excede 8MB` };
        const ext = path.extname(att.name).toLowerCase();
        if (!ALLOWED.includes(ext)) return { valid: false, error: `❌ Tipo não permitido: ${ext}` };
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
        console.warn("⚠️ Aviso: Falha ao buscar lista completa de membros:", e.message);
    }
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

function detectSoftBan(stats) {
    const total = stats.success + stats.fail + stats.closed;
    if (total < SOFT_BAN_MIN_SAMPLES) return false;
    return ((stats.closed + stats.fail) / total) >= SOFT_BAN_THRESHOLD;
}

async function readAttachmentJSON(message) {
    const attachment = message.attachments.first();
    if (!attachment || !attachment.name.endsWith('.json') || attachment.size > 1024 * 1024) {
        return { success: false, error: "❌ Nenhum arquivo JSON válido anexado (máx 1MB, deve ser '.json')" };
    }
    return new Promise(resolve => {
        https.get(attachment.url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ success: true, state: parsed });
                } catch (e) {
                    resolve({ success: false, error: "❌ Erro ao ler JSON. Arquivo corrompido." });
                }
            });
        }).on('error', (err) => {
            resolve({ success: false, error: `❌ Erro ao baixar: ${err.message}` });
        });
    });
}

async function getAiVariation(originalText, globalname) {
    // 1. Condição de Falha Imediata (se o modelo não carregar ou o texto for muito curto)
    if (!model || !originalText || originalText.length < 3) return originalText;
    
    try {
        const prompt = `
        Aja como um assistente de comunicação minimalista e eficiente. Reescreva a mensagem abaixo para a pessoa chamada "${globalname}".
        
        Regras:
        1. Mantenha EXATAMENTE o mesmo significado e intenção da "Mensagem Original".
        2. Se houver links (http...), MANTENHA-OS IDÊNTICOS.
        3. Mantenha o texto de saída no **mesmo idioma** da "Mensagem Original".
        4. **CRÍTICO:** Sua única função é fazer uma alteração pontual: **Troque APENAS UMA ÚNICA PALAVRA ou a saudação inicial por um sinônimo**. Mantenha o restante da frase (incluindo pontuação e estrutura) idêntico ao original. Se não for possível, é permitido inverter ordem das palavras se o sentido permanecer o mesmo.
        5. NÃO use aspas na resposta. Apenas o texto puro.

        Mensagem Original: "${originalText}"
        `;
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        
        // CORREÇÃO DE ROBUSTEZ: Verifica se a IA retornou texto vazio (apesar do prompt)
        if (!text || text.trim().length === 0) {
            console.warn("⚠️ IA retornou texto vazio ou inválido. Usando original.");
            return originalText;
        }
        
        return text.replace(/^"|"$/g, '').trim();
        
    } catch (error) {
        // CORREÇÃO DE FALLBACK: Em caso de erro na API (timeout, 404, etc.), retorna originalText
        console.warn(`⚠️ Erro na IA (Usando texto original): ${error.message}`);
        return originalText;
    }
}

// ============================================================================
// FUNÇÃO DE ENVIO UNIFICADO E INTELIGENTE
// ============================================================================

async function sendStealthDM(user, rawText, attachments) {
    let dmChannel;
    try {
        if (user.dmChannel) dmChannel = user.dmChannel;
        else dmChannel = await user.createDM();
    } catch (e) {
        return { success: false, reason: "closed" };
    }

    // GERAÇÃO POR IA
    let finalContent = rawText;
if (rawText) {
    // CORREÇÃO: Usar user.globalName, com fallback para user.username se globalName for null.
    const userDisplay = user.globalName || user.username || "amigo";
    finalContent = await getAiVariation(rawText, userDisplay);
}

    // Simula Comportamento Humano
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

    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await dmChannel.send(payload);
            console.log(`✅ Enviado para ${user.tag}: "${finalContent ? finalContent.substring(0, 30) : 'Imagem'}..."`);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            const code = err.code || 0;

            // Erros Críticos (Parada Imediata)
            if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                 console.error("🚨 DETECÇÃO DE SPAM PELO DISCORD (40003/Quarantine)");
                 await stateManager.modify(s => s.quarantine = true);
                 return { success: false, reason: "quarantine" };
            }
            
            if (code === 50007 || code === 50001) return { success: false, reason: "closed" };

            // Rate Limit
            if (err.retry_after || code === 20016) {
                const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;
                console.warn(`⏳ Rate Limit detectado. Esperando ${waitTime/1000}s.`);
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
// WORKER LOOP
// ============================================================================

async function workerLoop() {
    console.log("🚀 Worker Stealth Iniciado");
    const state = stateManager.state;
    const guildId = state.currentAnnounceGuildId;
    const gd = state.guildData[guildId] || {};

    try {
        let sentInBatch = 0;
        let currentBatchSize = getNextBatchSize();

        while (state.active && state.queue.length > 0) {
            
            // Gestão de Pausa de Lotes
            if (sentInBatch >= currentBatchSize) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                // Se for LOCAL, a pausa é minúscula (3s), se nuvem, segue regra stealth
                const pauseDuration = IS_LOCAL ? 3000 : (MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * pauseRange));
                
                console.log(`⏸️ Lote concluído. Pausa de ${(pauseDuration/1000).toFixed(0)}s.`);
                
                stateManager.forceSave();
                await updateProgressEmbed();
                
                await wait(pauseDuration);
                randomizeParameters();
                
                if (!stateManager.state.active || stateManager.state.queue.length === 0) break;
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
            }

            const userId = state.queue.shift();
            await stateManager.modify(() => {}); 

            // Filtro Rápido: Lista Negra Local (Array)
            if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                console.log(`⏭️ Ignorando ID na lista de bloqueio: ${userId}`);
                continue;
            }

            let user = client.users.cache.get(userId);
            if (!user) {
                try {
                    user = await client.users.fetch(userId); 
                } catch (e) {
                    console.log(`⏭️ Usuário inacessível: ${userId}`);
                    await stateManager.modify(s => {
                         if (!s.guildData[guildId].processedMembers.includes(userId)) {
                             s.guildData[guildId].processedMembers.push(userId);
                         }
                    });
                    continue;
                }
            }
            
            if (user.bot) continue;

            if (isSuspiciousAccount(user)) {
                console.log(`🚫 Pulando conta suspeita: ${user.tag}`);
                await stateManager.modify(s => {
                    if (!s.guildData[guildId].processedMembers.includes(userId)) {
                        s.guildData[guildId].processedMembers.push(userId);
                    }
                });
                continue;
            }

            const result = await sendStealthDM(user, state.text, state.attachments);

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
            
            if (result.success) {
                let delay = currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS);
                if (Math.random() < 0.1) delay += (IS_LOCAL ? 1000 : 30000); 
                await wait(delay);
            } else {
                const penalty = result.reason === "closed" ? (IS_LOCAL ? 1000 : 5000) : (IS_LOCAL ? 2000 : 20000);
                await wait(penalty);
            }

            sentInBatch++;
        }

        if (state.queue.length === 0 && state.active) {
            console.log("✅ Fila finalizada com sucesso.");
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
    workerLoop().catch(err => {
        console.error("💥 Exceção não tratada no Worker:", err);
        workerRunning = false;
        stateManager.forceSave();
    });
}

async function finalizeSending() {
    const state = stateManager.state;
    stopProgressUpdater();
    progressMessageRuntime = null;

    const guildId = state.currentAnnounceGuildId;
    const stats = { ...state.currentRunStats };
    const progressRef = state.progressMessageRef;

    await stateManager.modify(s => {
        if (guildId && s.queue.length > 0) {
            s.guildData[guildId].pendingQueue.push(...s.queue);
        }
        s.queue = [];
        s.active = false;
    });

    stateManager.forceSave();

    const gd = state.guildData[guildId] || {};
    const remaining = (gd.pendingQueue?.length || 0) + (gd.failedQueue?.length || 0);
    const embedColor = remaining === 0 && !state.quarantine ? 0x00FF00 : 0xFF0000;
    
    const embed = new EmbedBuilder()
        .setTitle("📬 Relatório de Envio")
        .setColor(embedColor)
        .addFields(
            { name: "✅ Sucesso", value: `${stats.success}`, inline: true },
            { name: "❌ Falhas", value: `${stats.fail}`, inline: true },
            { name: "🔒 Bloqueados", value: `${stats.closed}`, inline: true },
            { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
        )
        .setTimestamp();

    if (state.quarantine) {
        embed.addFields({
            name: "🚨 STATUS: QUARENTENA/INTERROMPIDO",
            value: "O bot interrompeu o envio para proteção. **Backup enviado.**",
            inline: false
        });
    }

    const finalText = remaining === 0 ? "✅ Campanha finalizada!" : `⏸️ Parado. Restam ${remaining} membros.`;

    if (progressRef) {
        try {
            const ch = await client.channels.fetch(progressRef.channelId).catch(() => null);
            if (ch?.isTextBased()) {
                const msg = await ch.messages.fetch(progressRef.messageId).catch(() => null);
                if (msg) await msg.edit({ content: finalText, embeds: [embed] }).catch(() => {});
                else await ch.send({ content: finalText, embeds: [embed] }).catch(() => {});
            }
        } catch (e) { console.error("❌ Erro postar resumo:", e.message); }
    }

    if (guildId && remaining === 0) {
        await stateManager.modify(s => {
            const gData = s.guildData[guildId];
            gData.lastAnnounceTime = Date.now();
            gData.totalSuccess = stats.success;
            gData.totalFail = stats.fail;
            gData.totalClosed = stats.closed;
            gData.processedMembers = []; 
            gData.failedQueue = [];
            gData.pendingQueue = [];
        });
    }

    await stateManager.modify(s => s.currentAnnounceGuildId = null);
    stateManager.forceSave();
}

async function updateProgressEmbed() {
    const state = stateManager.state;
    if (!state.progressMessageRef) return;

    const currentStats = JSON.stringify(state.currentRunStats);
    if (currentStats === lastEmbedState) return;
    lastEmbedState = currentStats;

    try {
        if (!progressMessageRuntime) {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (!ch) return;
            progressMessageRuntime = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        }
        
        if (!progressMessageRuntime) return;

        const embed = new EmbedBuilder()
            .setTitle("📨 Envio Stealth em Andamento")
            .setColor("#00AEEF")
            .setDescription(`Delay: ~${(currentDelayBase/1000).toFixed(0)}s | Lote: ${currentBatchBase}`)
            .addFields(
                { name: "✅ Sucesso", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 Bloqueados", value: `${state.currentRunStats.closed}`, inline: true },
                { name: "⏳ Fila", value: `${state.queue.length}`, inline: true }
            )
            .setTimestamp();

        await progressMessageRuntime.edit({ embeds: [embed] }).catch(() => {});
    } catch (e) { }
}

function startProgressUpdater() {
    if (progressUpdaterHandle) return;
    progressUpdaterHandle = setInterval(() => {
        if (stateManager.state.active) updateProgressEmbed();
    }, PROGRESS_UPDATE_INTERVAL);
}

function stopProgressUpdater() {
    if (progressUpdaterHandle) {
        clearInterval(progressUpdaterHandle);
        progressUpdaterHandle = null;
    }
}

function calculateCooldownInfo(guildData) {
    if (!guildData.lastAnnounceTime) return null;
    const now = Date.now();
    const lastSize = guildData.totalSuccess + guildData.totalClosed + guildData.totalFail;
    if (lastSize === 0) return null;
    const requiredCooldown = Math.max(GUILD_COOLDOWN_MIN_MS, lastSize * COOLDOWN_PENALTY_MS_PER_USER);
    const elapsed = now - guildData.lastAnnounceTime;
    
    if (elapsed >= requiredCooldown) return "✅ Disponível";
    
    const remaining = requiredCooldown - elapsed;
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.ceil((remaining % 3600000) / 60000);
    return `⏳ ${hours}h ${minutes}min restantes`;
}

// ============================================================================
// HANDLERS
// ============================================================================

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;
    const content = message.content.toLowerCase();
    const cmd = content.split(' ')[0];

    const isAnnounce = cmd.startsWith("!announce");
    const isResume = cmd === "!resume";
    const isStop = cmd === "!stop";
    const isUpdate = cmd === "!update";
    const isStatus = cmd === "!status";

    if (!isAnnounce && !isResume && !isStop && !isUpdate && !isStatus) return;

    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("⛔ Requer permissão de **Administrador**");
    }

    const guildId = message.guild.id;
    const state = stateManager.state;

    if (!state.guildData[guildId]) {
        await stateManager.modify(s => {
            s.guildData[guildId] = {
                lastAnnounceTime: 0,
                totalSuccess: 0, totalFail: 0, totalClosed: 0,
                failedQueue: [], pendingQueue: [],
                lastRunText: "", lastRunAttachments: [],
                processedMembers: [], blockedDMs: []
            };
        });
    }

    const gd = state.guildData[guildId];

    if (isStatus) {
        const isActive = state.active && state.currentAnnounceGuildId === guildId;
        const embed = new EmbedBuilder()
            .setTitle("📊 Status do Sistema Stealth")
            .setColor(isActive ? 0x00FF00 : 0x808080)
            .addFields(
                { name: "Estado", value: isActive ? "🟢 Ativo" : "⚪ Parado", inline: true },
                { name: "Pendentes", value: `${gd.pendingQueue.length}`, inline: true },
                { name: "Bloqueados", value: `${gd.blockedDMs.length}`, inline: true }
            );

        if (isActive) {
            embed.addFields(
                { name: "✅ Enviadas", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Erros", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 Fechadas", value: `${state.currentRunStats.closed}`, inline: true }
            );
        }

        const cooldownInfo = calculateCooldownInfo(gd);
        if (cooldownInfo) embed.addFields({ name: "⏰ Cooldown", value: cooldownInfo, inline: false });
        
        return message.reply({ embeds: [embed] });
    }

    if (isStop) {
        if (!state.active || state.currentAnnounceGuildId !== guildId) return message.reply("⚠️ Nenhum envio ativo.");
        await stateManager.modify(s => s.active = false);
        await sendBackupEmail("Parada Manual (!stop)", stateManager.state);
        return message.reply("⏸️ Envio pausado.");
    }

    if (isUpdate) {
        if (!gd.lastRunText && gd.lastRunAttachments.length === 0) return message.reply("❌ Nenhuma campanha anterior.");
        const members = await getCachedMembers(message.guild);
        const newIds = [];
        members.forEach(m => {
            if (!m.user.bot && !gd.processedMembers.includes(m.id) && !gd.blockedDMs.includes(m.id)) {
                newIds.push(m.id);
            }
        });
        if (newIds.length === 0) return message.reply("✅ Nenhum membro novo.");
        const isActive = state.active && state.currentAnnounceGuildId === guildId;
        await stateManager.modify(s => {
            if (isActive) s.queue.push(...newIds);
            else s.guildData[guildId].pendingQueue.push(...newIds);
            newIds.forEach(id => {
                if (!s.guildData[guildId].processedMembers.includes(id)) s.guildData[guildId].processedMembers.push(id);
            });
        });
        return message.reply(`➕ Adicionados **${newIds.length}** membros.`);
    }

    if (isResume) {
        if (state.active) return message.reply("⚠️ Já existe um envio ativo.");
        let stateToLoad = null;
        let resumeSource = "local";

        if (message.attachments.size > 0) {
            const jsonResult = await readAttachmentJSON(message);
            if (!jsonResult.success) return message.reply(jsonResult.error);
            if (jsonResult.state.currentAnnounceGuildId !== guildId) return message.reply("❌ Arquivo de outro servidor.");
            stateToLoad = jsonResult.state;
            resumeSource = "anexo";
        }
        
        if (stateToLoad) {
            const tempState = stateManager.load(stateToLoad);
            if (!tempState) return message.reply("❌ Erro ao carregar arquivo.");
            await stateManager.modify(s => Object.assign(s, tempState));
        }
        
        const currentGd = stateManager.state.guildData[guildId];
        const allIds = [...new Set([...currentGd.pendingQueue, ...currentGd.failedQueue])]
            .filter(id => !currentGd.blockedDMs.includes(id));

        if (allIds.length === 0) return message.reply(`✅ Nenhum membro para retomar.`);

        await stateManager.modify(s => {
            s.active = true;
            s.quarantine = false;
            s.currentAnnounceGuildId = guildId;
            s.text = currentGd.lastRunText || "";
            s.attachments = currentGd.lastRunAttachments || [];
            s.queue = allIds;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            s.guildData[guildId].pendingQueue = [];
            s.guildData[guildId].failedQueue = [];
        });

        const progressMsg = await message.reply(`🔄 Retomando envio para **${allIds.length}** membros...`);
        await stateManager.modify(s => {
            s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
        });
        startProgressUpdater();
        startWorker();
        return;
    }

    if (isAnnounce) {
        if (state.active) return message.reply("❌ Já existe um envio ativo.");
        const parsed = parseSelectors(message.content.slice(cmd.length).trim());
        const text = parsed.cleaned;
        const attachments = [...message.attachments.values()];

        if (!text && attachments.length === 0) return message.reply("❌ Envie texto ou anexo.");
        if (attachments.length > 0) {
            const validation = validateAttachments(attachments);
            if (!validation.valid) return message.reply(validation.error);
        }

        const totalRemaining = gd.pendingQueue.length + gd.failedQueue.length;
        if (totalRemaining > 0 && !parsed.hasForce) {
            return message.reply(`⚠️ Há **${totalRemaining}** pendentes. Use \`!resume\` ou adicione \`force\`.`);
        }

        const cooldownInfo = calculateCooldownInfo(gd);
        if (!IS_LOCAL && cooldownInfo && cooldownInfo.includes("restantes")) {
            return message.reply(`⛔ **Cooldown Ativo:**\n${cooldownInfo}`);
        }

        if (totalRemaining > 0 && parsed.hasForce) {
            await stateManager.modify(s => {
                s.guildData[guildId].pendingQueue = [];
                s.guildData[guildId].failedQueue = [];
            });
            await message.reply(`🗑️ Fila anterior descartada.`);
        }

        const members = await getCachedMembers(message.guild);
        const queue = [];
        const processedSet = new Set();
        const mode = cmd.includes("for") ? "for" : "announce";

        members.forEach(m => {
            if (m.user.bot) return;
            // Agora blockedDMs é array, então .includes funciona corretamente
            if (gd.blockedDMs.includes(m.id)) return;
            if (mode === "for" && !parsed.only.has(m.id)) return;
            if (mode === "announce" && parsed.ignore.has(m.id)) return;
            queue.push(m.id);
            processedSet.add(m.id);
        });

        if (queue.length === 0) return message.reply("❌ Nenhum membro encontrado.");

        const formattedAttachments = attachments.map(a => a.url);
        await stateManager.modify(s => {
            s.active = true;
            s.quarantine = false;
            s.currentAnnounceGuildId = guildId;
            s.text = text;
            s.attachments = formattedAttachments;
            s.queue = queue;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            s.ignore = parsed.ignore;
            s.only = parsed.only;
            const gData = s.guildData[guildId];
            gData.lastRunText = text;
            gData.lastRunAttachments = formattedAttachments;
            gData.processedMembers = [...processedSet];
        });

        const progressMsg = await message.reply(`🚀 Iniciando envio Stealth para **${queue.length}** membros...`);
        await stateManager.modify(s => {
            s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id };
        });
        startProgressUpdater();
        startWorker();
    }
});

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

client.on("ready", async () => {
    console.log(`✅ Bot online como: ${client.user.tag} (Modo Stealth Ativado)`);
    const state = stateManager.state;
    
    if (state.progressMessageRef) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (ch) progressMessageRuntime = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
        } catch (e) { }
    }
    
    if (state.active && state.queue.length > 0) {
        console.log(`🔄 Auto-Resume: ${state.queue.length} membros...`);
        startProgressUpdater();
        startWorker();
    } else if (state.active && state.queue.length === 0) {
        await stateManager.modify(s => { s.active = false; s.currentAnnounceGuildId = null; });
        stateManager.forceSave();
    }
});

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