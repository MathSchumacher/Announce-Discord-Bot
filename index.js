require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https"); // Necessário para baixar o anexo JSON
const nodemailer = require("nodemailer"); // Necessário para enviar o backup por e-mail
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require("discord.js");

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
const SOFT_BAN_THRESHOLD = 0.4; // Se 40% das tentativas falharem, ativa o modo de emergência (mais restrito)
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
        
        // Remove duplicatas e remove usuários que estão na lista de bloqueio permanente (blockedDMs)
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
        // Se um estado inicial for passado (via anexo), usamos ele como base
        const stateToLoad = initialState || this.getInitialState();
        
        try {
            // Se não foi passado estado via parâmetro, lemos do disco
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            // Reconverte Arrays para Sets (pois JSON não salva Sets)
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // Reconverte dados específicos das Guilds
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = new Set(Array.isArray(gd.processedMembers) ? gd.processedMembers : []);
                // Lista de bloqueio permanente (Blocked DMs)
                gd.blockedDMs = new Set(Array.isArray(gd.blockedDMs) ? gd.blockedDMs : []); 
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
            // Prepara objeto para serialização (Converte Sets para Arrays)
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
                    blockedDMs: [...data.blockedDMs] // Salva a lista negra
                };
            }

            fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
            this.unsavedChanges = 0;
        } catch (e) {
            console.error("❌ Erro ao salvar estado no disco:", e);
        }
    }

    async modify(callback) {
        // Sistema de fila para evitar corrupção de dados em escritas simultâneas
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
            
            // 2. Verifica se precisa enviar backup por e-mail (se houver pendências)
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
// UTILITÁRIOS E AUXILIARES (COM MELHORIAS HUMANAS)
// ============================================================================

const wait = ms => new Promise(r => setTimeout(r, ms));

function randomizeParameters() {
    // Humanizer: Muda o delay base para não parecer robô
    currentDelayBase = Math.floor(Math.random() * (35000 - 22000 + 1)) + 22000; 
    currentBatchBase = Math.floor(Math.random() * (15 - 8 + 1)) + 8; 
    
    console.log(`🎲 Humanizer: Novo Ritmo -> Delay ~${(currentDelayBase/1000).toFixed(1)}s | Lote ~${currentBatchBase} msgs`);
}

function getNextBatchSize() {
    const min = Math.max(1, currentBatchBase - BATCH_VARIANCE);
    const max = currentBatchBase + BATCH_VARIANCE;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Função para calcular "tempo de leitura/digitação" baseado no texto
function calculateTypingTime(text) {
    if (!text) return 1500; // Se for só imagem, 1.5s
    const charactersPerSecond = 15; // Velocidade média de digitação humana relaxada
    const ms = (text.length / charactersPerSecond) * 1000;
    return Math.min(9000, Math.max(2500, ms)); // Mínimo 2.5s, Máximo 9s
}

// Filtro de "Conta Fria" ou suspeita
function isSuspiciousAccount(user) {
    // 1. Verifica idade da conta
    const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (ageInDays < MIN_ACCOUNT_AGE_DAYS) return true;

    // 2. Verifica Avatar (contas sem avatar são frequentemente monitoradas)
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
    // Remove a palavra force do texto final
    const finalText = hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned;
    
    return { cleaned: finalText, ignore, only, hasForce };
}

function getVariedText(text) {
    if (!text || text.includes("http")) return text || "";
    // Adiciona caracteres invisíveis aleatórios para mudar o hash da mensagem
    const invisibleChars = ["\u200B", "\u200C", "\u200D", "\u2060"];
    const randomChar = invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
    return `${text}${randomChar}`;
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
        console.warn("⚠️ Aviso: Falha ao buscar lista completa de membros:", e.message);
    }
    
    const members = guild.members.cache;
    memberCache.set(guild.id, { members, timestamp: Date.now() });
    return members;
}

function detectSoftBan(stats) {
    const total = stats.success + stats.fail + stats.closed;
    if (total < SOFT_BAN_MIN_SAMPLES) return false;
    // Se a taxa de erro for muito alta, retorna true
    return ((stats.closed + stats.fail) / total) >= SOFT_BAN_THRESHOLD;
}

async function readAttachmentJSON(message) {
    const attachment = message.attachments.first();
    // Valida tamanho e extensão
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

// ============================================================================
// FUNÇÃO DE ENVIO UNIFICADO E INTELIGENTE (O CORAÇÃO DA MELHORIA)
// ============================================================================

async function sendStealthDM(user, contentText, attachments) {
    // 1. Cria o canal primeiro para poder enviar "Typing"
    let dmChannel;
    try {
        dmChannel = await user.createDM();
    } catch (e) {
        return { success: false, reason: "closed" }; // DM Fechada
    }

    // 2. Simula Comportamento Humano (Typing...)
    try {
        await dmChannel.sendTyping();
        const typeTime = calculateTypingTime(contentText);
        await wait(typeTime);
    } catch (e) { /* Ignora erro no typing */ }

    // 3. Prepara Payload Único (Muito mais seguro que enviar separado)
    const payload = {};
    if (contentText) payload.content = getVariedText(contentText);
    if (attachments && attachments.length > 0) payload.files = attachments;

    // 4. Loop de Tentativa com Backoff Inteligente
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await dmChannel.send(payload);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            
            // Erro 50007: DM Fechada
            if (err.code === 50007) {
                return { success: false, reason: "closed" };
            }
            
            // Detecção de Quarentena/Spam flag
            if (errMsg.includes("quarantine") || errMsg.includes("flagged") || errMsg.includes("spam")) {
                console.error("🚨 ALERTA MÁXIMO: QUARENTENA DETECTADA PELA API");
                await stateManager.modify(s => s.quarantine = true);
                return { success: false, reason: "quarantine" };
            }
            
            // Auto-Adaptação a Rate Limit (Retry After)
            if (err.retry_after) {
                const waitTime = err.retry_after * 1000 + 5000;
                console.warn(`⏳ Rate limit (API): Discord pediu calma. Aumentando delays futuros e esperando ${waitTime}ms.`);
                
                // "Aprende" que precisa ir mais devagar
                currentDelayBase += 5000; 
                currentBatchBase = Math.max(5, currentBatchBase - 2);

                await wait(waitTime);
                continue;
            }
            
            // Erro 429 Genérico
            if (err.status === 429 || err.statusCode === 429) {
                const backoff = 15000 * attempt;
                console.warn(`⏳ 429 Genérico: aguardando ${backoff}ms`);
                await wait(backoff);
                continue;
            }
            
            // Outros erros
            const backoff = 3000 * attempt;
            console.error(`❌ Erro envio DM (${attempt}/${RETRY_LIMIT}): ${err.message}`);
            if (attempt < RETRY_LIMIT) {
                await wait(backoff);
            }
        }
    }
    
    return { success: false, reason: "fail" };
}

// ============================================================================
// WORKER LOOP (REESCRITO PARA SEGURANÇA MÁXIMA)
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
            
            // === 1. GESTÃO DE PAUSA DE LOTES (COM RANDOMIZAÇÃO) ===
            if (sentInBatch >= currentBatchSize) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                const pauseDuration = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * pauseRange);
                
                console.log(`⏸️ Lote (${sentInBatch}) concluído. Descansando por ${(pauseDuration/60000).toFixed(1)} minutos (Stealth Mode).`);
                
                // Salva estado e atualiza UI antes de dormir
                stateManager.forceSave();
                await updateProgressEmbed();
                
                await wait(pauseDuration);
                
                // Recalcula parâmetros para variar comportamento
                randomizeParameters();
                
                if (!stateManager.state.active || stateManager.state.queue.length === 0) break;
                
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
            }

            // === 2. PREPARAÇÃO DO USUÁRIO ===
            const userId = state.queue.shift();
            await stateManager.modify(() => {}); // Trigger save check

            // Filtro Rápido: Lista Negra Local
            if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                console.log(`⏭️ Ignorando ID na lista de bloqueio: ${userId}`);
                continue;
            }

            // Busca usuário no Discord
            let user;
            try {
                user = await client.users.fetch(userId);
            } catch (e) {
                console.log(`⏭️ Usuário não encontrado/inválido: ${userId}`);
                continue;
            }
            
            if (user.bot) continue;

            // === 3. FILTRO DE QUALIDADE DE CONTA (ANTI-ARMADILHA) ===
            if (isSuspiciousAccount(user)) {
                console.log(`🚫 Pulando conta suspeita/fria (Nova ou sem Avatar): ${user.tag}`);
                // Opcional: Marcar como processado para não tentar de novo na mesma sessão
                await stateManager.modify(s => {
                    if (!s.guildData[guildId].processedMembers.includes(userId)) {
                        s.guildData[guildId].processedMembers.push(userId);
                    }
                });
                continue;
            }

            // === 4. ENVIO UNIFICADO (TEXTO + IMAGEM JUNTOS) ===
            const result = await sendStealthDM(user, state.text, state.attachments);

            // === 5. ATUALIZAÇÃO DE ESTATÍSTICAS ===
            await stateManager.modify(s => {
                const gData = s.guildData[guildId];
                
                if (result.success) {
                    s.currentRunStats.success++;
                    // Remove da lista de falhas antiga se existir
                    const idx = gData.failedQueue.indexOf(userId);
                    if (idx > -1) gData.failedQueue.splice(idx, 1);
                } else {
                    if (result.reason === "closed") {
                        s.currentRunStats.closed++;
                        if (!gData.blockedDMs.includes(userId)) gData.blockedDMs.push(userId);
                    } else if (result.reason === "quarantine") {
                        // A flag quarantine já foi setada dentro do sendStealthDM
                        s.active = false;
                    } else {
                        s.currentRunStats.fail++;
                        if (!gData.failedQueue.includes(userId)) gData.failedQueue.push(userId);
                    }
                }
                
                // Marca como processado
                if (!gData.processedMembers.includes(userId)) gData.processedMembers.push(userId);
            });

            // === 6. VERIFICAÇÕES DE SEGURANÇA PÓS-ENVIO ===
            
            // Se entrou em quarentena, para tudo e manda e-mail
            if (stateManager.state.quarantine) {
                await sendBackupEmail("Quarentena Detectada (API Flag)", stateManager.state);
                break;
            }

            // Detecção de Soft-Ban (Muitos erros seguidos)
            if (detectSoftBan(state.currentRunStats)) {
                console.error("🚨 SOFT-BAN DETECTADO: Taxa de erro excedeu limite seguro.");
                await stateManager.modify(s => {
                    s.quarantine = true;
                    s.active = false;
                });
                await sendBackupEmail("Soft-Ban (Alta taxa de rejeição)", stateManager.state);
                break;
            }

            updateProgressEmbed().catch(() => {});
            
            // === 7. DELAY INTELIGENTE (MENTAL PAUSE) ===
            if (result.success) {
                let delay = currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS);
                
                // 10% de chance de uma "pausa mental" extra (simula o humano se distraindo)
                if (Math.random() < 0.1) {
                    delay += 30000; // +30s
                    console.log("☕ Pausa mental simulada (+30s)...");
                }
                
                await wait(delay);
            } else {
                // Se falhou, aplica penalidade de espera
                const penalty = result.reason === "closed" ? 5000 : 20000;
                await wait(penalty);
            }

            sentInBatch++;
        }

        // Conclusão da fila
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
        const wasInterrupted = finalState.queue.length > 0 && (!finalState.active || finalState.quarantine);
        
        if (wasInterrupted) {
            console.log("⚠️ Worker interrompido antes do fim da fila.");
            await finalizeSending();
        }
    }
}

function startWorker() {
    if (workerRunning) {
        console.log("⚠️ Tentativa de iniciar worker duplicado ignorada.");
        return;
    }
    workerRunning = true;
    workerLoop().catch(err => {
        console.error("💥 Exceção não tratada no Worker:", err);
        workerRunning = false;
        stateManager.forceSave();
    });
}

// ============================================================================
// FINALIZAÇÃO E LIMPEZA
// ============================================================================

async function finalizeSending() {
    const state = stateManager.state;
    stopProgressUpdater();
    progressMessageRuntime = null;

    const guildId = state.currentAnnounceGuildId;
    const stats = { ...state.currentRunStats };
    const progressRef = state.progressMessageRef;

    // Move o que sobrou na fila para pendingQueue
    await stateManager.modify(s => {
        if (guildId && s.queue.length > 0) {
            s.guildData[guildId].pendingQueue.push(...s.queue);
        }
        s.queue = [];
        s.active = false;
    });

    stateManager.forceSave();

    // Prepara dados para o Embed Final
    const gd = state.guildData[guildId] || {};
    const remaining = (gd.pendingQueue?.length || 0) + (gd.failedQueue?.length || 0);

    // Se estiver em quarentena, é vermelho. Se acabou, verde.
    const embedColor = remaining === 0 && !state.quarantine ? 0x00FF00 : 0xFF0000;
    
    const embed = new EmbedBuilder()
        .setTitle("📬 Relatório de Envio")
        .setColor(embedColor)
        .addFields(
            { name: "✅ Sucesso", value: `${stats.success}`, inline: true },
            { name: "❌ Falhas", value: `${stats.fail}`, inline: true },
            { name: "🔒 Bloqueados (DMs)", value: `${stats.closed}`, inline: true },
            { name: "⏳ Pendentes", value: `${remaining}`, inline: true }
        )
        .setTimestamp();

    if (state.quarantine) {
        embed.addFields({
            name: "🚨 STATUS: QUARENTENA/INTERROMPIDO",
            value: "O bot interrompeu o envio para proteção. **Um backup foi enviado para seu e-mail.**",
            inline: false
        });
    }

    const finalText = remaining === 0
        ? "✅ Campanha finalizada!"
        : `⏸️ Parado. Restam ${remaining} membros. Use \`!resume\` para continuar.`;

    // Atualiza mensagem no Discord
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
            console.error("❌ Erro ao postar resumo final:", e.message);
        }
    }

    // Aplica Cooldown na Guild se finalizou tudo
    if (guildId && remaining === 0) {
        await stateManager.modify(s => {
            const gData = s.guildData[guildId];
            gData.lastAnnounceTime = Date.now();
            gData.totalSuccess = stats.success;
            gData.totalFail = stats.fail;
            gData.totalClosed = stats.closed;
            
            // Limpa listas temporárias
            gData.processedMembers = []; 
            gData.failedQueue = [];
            gData.pendingQueue = [];
            // OBS: blockedDMs NÃO é limpo, é permanente.
        });
    }

    // Limpa referência global
    await stateManager.modify(s => s.currentAnnounceGuildId = null);
    stateManager.forceSave();
}

// UI UPDATER
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

        let remaining = state.queue.length;
        
        const embed = new EmbedBuilder()
            .setTitle("📨 Envio Stealth em Andamento")
            .setColor("#00AEEF")
            .setDescription(`Delay Atual: ~${(currentDelayBase/1000).toFixed(0)}s | Lote: ${currentBatchBase}`)
            .addFields(
                { name: "✅ Sucesso", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 Bloqueados", value: `${state.currentRunStats.closed}`, inline: true },
                { name: "⏳ Fila", value: `${remaining}`, inline: true }
            )
            .setTimestamp();

        await progressMessageRuntime.edit({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        // Ignora erros de UI
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
    
    return `⏳ ${hours}h ${minutes}min restantes`;
}

// ============================================================================
// HANDLERS DE COMANDOS
// ============================================================================

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

    if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("⛔ Requer permissão de **Administrador**");
    }

    const guildId = message.guild.id;
    const state = stateManager.state;

    // Inicialização dos dados da Guild
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

    // --- COMANDO: STATUS ---
    if (isStatus) {
        const isActive = state.active && state.currentAnnounceGuildId === guildId;
        const embed = new EmbedBuilder()
            .setTitle("📊 Status do Sistema Stealth")
            .setColor(isActive ? 0x00FF00 : 0x808080)
            .addFields(
                { name: "Estado", value: isActive ? "🟢 Ativo" : "⚪ Parado", inline: true },
                { name: "Pendentes", value: `${gd.pendingQueue.length}`, inline: true },
                { name: "Bloqueados (DM Off)", value: `${gd.blockedDMs.length}`, inline: true }
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
            embed.addFields({ name: "⏰ Cooldown Sugerido", value: cooldownInfo, inline: false });
        }

        return message.reply({ embeds: [embed] });
    }

    // --- COMANDO: STOP ---
    if (isStop) {
        if (!state.active || state.currentAnnounceGuildId !== guildId) {
            return message.reply("⚠️ Nenhum envio ativo neste servidor");
        }
        
        await stateManager.modify(s => s.active = false);
        // Força backup ao parar manualmente
        await sendBackupEmail("Parada Manual (!stop)", stateManager.state);
        
        return message.reply("⏸️ Envio pausado. Backup de segurança enviado para o e-mail.");
    }

    // --- COMANDO: UPDATE ---
    if (isUpdate) {
        if (!gd.lastRunText && gd.lastRunAttachments.length === 0) {
            return message.reply("❌ Nenhuma campanha anterior encontrada.");
        }

        const members = await getCachedMembers(message.guild);
        const newIds = [];

        members.forEach(m => {
            // Heurística: Ignora bots, já processados e DMs bloqueadas
            if (!m.user.bot && !gd.processedMembers.includes(m.id) && !gd.blockedDMs.includes(m.id)) {
                newIds.push(m.id);
            }
        });

        if (newIds.length === 0) {
            return message.reply("✅ Nenhum membro novo elegível para adicionar.");
        }

        const isActive = state.active && state.currentAnnounceGuildId === guildId;

        await stateManager.modify(s => {
            if (isActive) {
                s.queue.push(...newIds);
            } else {
                s.guildData[guildId].pendingQueue.push(...newIds);
            }
            // Marca como processados
            const currentGd = s.guildData[guildId];
            newIds.forEach(id => {
                if (!currentGd.processedMembers.includes(id)) currentGd.processedMembers.push(id);
            });
        });

        const targetQueue = isActive ? "ativa" : "pendente";
        return message.reply(`➕ Adicionados **${newIds.length}** novos membros à fila ${targetQueue}.`);
    }

    // --- COMANDO: RESUME ---
    if (isResume) {
        if (state.active) {
            return message.reply("⚠️ Já existe um envio ativo globalmente");
        }

        let stateToLoad = null;
        let resumeSource = "local";

        // Verifica anexo JSON
        if (message.attachments.size > 0) {
            const jsonResult = await readAttachmentJSON(message);
            if (!jsonResult.success) {
                return message.reply(jsonResult.error);
            }
            
            if (jsonResult.state.currentAnnounceGuildId !== guildId) {
                return message.reply("❌ O arquivo de estado pertence a outro servidor.");
            }
            
            stateToLoad = jsonResult.state;
            resumeSource = "anexo";
        }
        
        // Carrega estado (do anexo ou local)
        if (stateToLoad) {
            const tempState = stateManager.load(stateToLoad);
            if (!tempState) return message.reply("❌ Erro ao carregar arquivo.");
            await stateManager.modify(s => Object.assign(s, tempState));
        }
        
        const currentState = stateManager.state;
        const currentGd = currentState.guildData[guildId];

        // Reconstrói fila de pendentes + falhas, filtrando bloqueados
        const allIds = [...new Set([...currentGd.pendingQueue, ...currentGd.failedQueue])]
            .filter(id => !currentGd.blockedDMs.includes(id));

        if (allIds.length === 0) {
            return message.reply(`✅ Nenhum membro válido para retomar (${resumeSource}).`);
        }

        if (!currentGd.lastRunText && (!currentGd.lastRunAttachments || currentGd.lastRunAttachments.length === 0)) {
            return message.reply("❌ Dados da campanha perdidos.");
        }

        await stateManager.modify(s => {
            s.active = true;
            s.quarantine = false; // Reseta flag de quarentena
            s.currentAnnounceGuildId = guildId;
            s.text = currentGd.lastRunText || "";
            s.attachments = currentGd.lastRunAttachments || [];
            s.queue = allIds;
            s.currentRunStats = { success: 0, fail: 0, closed: 0 };
            
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

    // --- COMANDO: ANNOUNCE ---
    if (isAnnounce) {
        if (state.active) {
            return message.reply("❌ Já existe um envio ativo.");
        }

        const parsed = parseSelectors(message.content.slice(cmd.length).trim());
        const text = parsed.cleaned;
        const attachments = [...message.attachments.values()];

        if (!text && attachments.length === 0) {
            return message.reply("❌ Envie texto ou anexo.");
        }

        if (attachments.length > 0) {
            const validation = validateAttachments(attachments);
            if (!validation.valid) return message.reply(validation.error);
        }

        const pendingCount = gd.pendingQueue.length;
        const failedCount = gd.failedQueue.length;
        const totalRemaining = pendingCount + failedCount;

        if (totalRemaining > 0 && !parsed.hasForce) {
            return message.reply(
                `⚠️ Há **${totalRemaining}** membros pendentes.\n` +
                `Use \`!resume\` para continuar ou adicione \`force\` ao comando para descartá-los.`
            );
        }

        // Verifica Cooldown
        const cooldownInfo = calculateCooldownInfo(gd);
        if (cooldownInfo && cooldownInfo.includes("restantes")) {
            return message.reply(`⛔ **Cooldown Ativo:**\n${cooldownInfo}`);
        }

        // Limpa filas se forçado
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

        // Constrói a fila
        members.forEach(m => {
            // 1. Ignora Bots
            if (m.user.bot) return;
            
            // 2. Filtro de Bloqueados (Permanente)
            if (gd.blockedDMs.includes(m.id)) return;

            // 3. Filtros de Comando
            if (mode === "for" && !parsed.only.has(m.id)) return;
            if (mode === "announce" && parsed.ignore.has(m.id)) return;

            queue.push(m.id);
            processedSet.add(m.id);
        });

        if (queue.length === 0) {
            return message.reply("❌ Nenhum membro encontrado após filtros.");
        }

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
            s.progressMessageRef = {
                channelId: progressMsg.channel.id,
                messageId: progressMsg.id
            };
        });

        startProgressUpdater();
        startWorker();
    }
});

// ============================================================================
// INICIALIZAÇÃO (BOOTSTRAP)
// ============================================================================

client.on("ready", async () => {
    console.log(`✅ Bot online como: ${client.user.tag} (Modo Stealth Ativado)`);
    
    const state = stateManager.state;
    
    // Tenta reconectar à mensagem de progresso anterior
    if (state.progressMessageRef) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (ch) {
                progressMessageRuntime = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
            }
        } catch (e) {
            console.warn("⚠️ Msg progresso não recuperada.");
        }
    }
    
    // Auto-Resume se o processo caiu enquanto estava ativo
    if (state.active && state.queue.length > 0) {
        console.log(`🔄 Auto-Resume: Retomando envio de ${state.queue.length} membros...`);
        startProgressUpdater();
        startWorker();
    } else if (state.active && state.queue.length === 0) {
        console.warn("⚠️ Estado inconsistente detectado. Limpando.");
        await stateManager.modify(s => {
            s.active = false;
            s.currentAnnounceGuildId = null;
        });
        stateManager.forceSave();
    }
});

// Tratamento de erros globais
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

if (!process.env.DISCORD_TOKEN) {
    console.error("❌ Erro: DISCORD_TOKEN não encontrado no arquivo .env");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("❌ Falha no login do Discord:", err);
    process.exit(1);
});