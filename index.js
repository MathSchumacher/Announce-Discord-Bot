require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https"); // Necessário para baixar o anexo JSON
const nodemailer = require("nodemailer"); // Necessário para enviar o backup por e-mail
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require("discord.js");

// ============================================================================
// CONFIGURAÇÕES GERAIS E CONSTANTES
// ============================================================================

const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// === SEGURANÇA ANTI-QUARENTENA (MODO SEGURO) ===
// Valores aumentados para evitar detecção de spam pelo Discord
let currentDelayBase = 25000; // 25 segundos de delay base entre mensagens
const DELAY_RANDOM_MS = 15000; // Adiciona de 0 a 15 segundos aleatórios extras
let currentBatchBase = 15; // Tamanho base do lote (envia 15, depois pausa)
const BATCH_VARIANCE = 5; // Variação do lote (entre 10 e 20 mensagens)
const MIN_BATCH_PAUSE_MS = 10 * 60 * 1000; // Pausa mínima de 10 minutos entre lotes
const MAX_BATCH_PAUSE_MS = 20 * 60 * 1000; // Pausa máxima de 20 minutos entre lotes

// === COOLDOWN DINÂMICO POR SERVIDOR ===
const GUILD_COOLDOWN_MIN_HOURS = 6;
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 2000; // Adiciona 2s de cooldown para cada usuário enviado

// === OTIMIZAÇÃO E PROTEÇÃO CONTRA SOFT-BAN ===
const SAVE_THRESHOLD = 5; // Salva o arquivo JSON a cada 5 alterações de estado
const MEMBER_CACHE_TTL = 5 * 60 * 1000; // Cache de lista de membros por 5 minutos
const SOFT_BAN_THRESHOLD = 0.5; // Se 50% das tentativas falharem, ativa o modo de emergência
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
        source: "Bot_Resume_System_Full",
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
        subject: `🚨 Bot Backup Alert: ${reason}`,
        text: `O sistema de envio foi interrompido.\n\n` +
              `📌 Motivo: ${reason}\n` +
              `👥 Usuários Restantes: ${remainingUsers.length}\n\n` +
              `COMO RETOMAR:\n` +
              `1. Baixe o arquivo JSON anexado.\n` +
              `2. Vá ao servidor Discord correto.\n` +
              `3. Use o comando !resume e anexe este arquivo na mensagem.`,
        attachments: [
            {
                filename: `resume_backup_${Date.now()}.json`,
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
// UTILITÁRIOS E AUXILIARES
// ============================================================================

const wait = ms => new Promise(r => setTimeout(r, ms));

function randomizeParameters() {
    // Define novos parâmetros aleatórios para humanizar o comportamento
    // Delay entre 20s e 30s
    currentDelayBase = Math.floor(Math.random() * (30000 - 20000 + 1)) + 20000; 
    // Lote entre 10 e 20 mensagens
    currentBatchBase = Math.floor(Math.random() * (20 - 10 + 1)) + 10; 
    
    console.log(`🎲 Humanizer: Novo Ritmo -> Delay ~${(currentDelayBase/1000).toFixed(1)}s | Lote ~${currentBatchBase} msgs`);
}

function getNextBatchSize() {
    const min = Math.max(1, currentBatchBase - BATCH_VARIANCE);
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
    // Remove a palavra force do texto final
    const finalText = hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned;
    
    return { cleaned: finalText, ignore, only, hasForce };
}

function getVariedText(text) {
    if (!text || text.includes("http")) return text || "";
    // Adiciona caracteres invisíveis aleatórios para mudar o hash da mensagem
    // Isso ajuda a evitar que o Discord agrupe as mensagens como spam idêntico
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
    // Se a taxa de erro (fechadas + falhas) for maior que o limite (50%), retorna true
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

async function sendDM(user, payload) {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await user.send(payload);
            return { success: true };
        } catch (err) {
            const errMsg = (err.message || "").toLowerCase();
            
            // DM Fechada (Erro 50007) - Não adianta tentar de novo
            if (err.code === 50007) {
                return { success: false, reason: "closed" };
            }
            
            // Detecção de Quarentena/Spam flag
            if (errMsg.includes("quarantine") || errMsg.includes("flagged") || errMsg.includes("spam")) {
                console.error("🚨 ALERTA MÁXIMO: QUARENTENA DETECTADA PELA API");
                await stateManager.modify(s => s.quarantine = true);
                return { success: false, reason: "quarantine" };
            }
            
            // Rate Limit com tempo específico
            if (err.retry_after) {
                const waitTime = err.retry_after * 1000 + 2000;
                console.warn(`⏳ Rate limit (API): aguardando ${waitTime}ms`);
                await wait(waitTime);
                continue;
            }
            
            // Erro 429 Genérico
            if (err.status === 429 || err.statusCode === 429) {
                const backoff = 10000 * attempt; // Espera longa
                console.warn(`⏳ 429 Genérico: aguardando ${backoff}ms`);
                await wait(backoff);
                continue;
            }
            
            // Outros erros - backoff exponencial curto
            const backoff = 2000 * attempt;
            console.error(`❌ Erro envio DM (${attempt}/${RETRY_LIMIT}): ${err.message}`);
            if (attempt < RETRY_LIMIT) {
                await wait(backoff);
            }
        }
    }
    
    return { success: false, reason: "fail" };
}

// ============================================================================
// WORKER LOOP (O CORAÇÃO DO BOT)
// ============================================================================

async function workerLoop() {
    console.log("🚀 Worker de envio iniciado (Modo Seguro Ativado)");
    const state = stateManager.state;
    const guildId = state.currentAnnounceGuildId;
    // Obtém referência para os dados da guild atual
    const gd = state.guildData[guildId] || {};

    try {
        let sentInBatch = 0;
        let currentBatchSize = getNextBatchSize();

        while (state.active && state.queue.length > 0) {
            
            // === 1. VERIFICAÇÃO DE PAUSA DE LOTE ===
            if (sentInBatch >= currentBatchSize) {
                const pauseRange = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS;
                const pauseDuration = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * pauseRange);
                const pauseMinutes = (pauseDuration / 60000).toFixed(1);
                
                console.log(`⏸️ Fim do lote (${sentInBatch} envios). Pausando por ~${pauseMinutes} minutos para segurança.`);
                
                // Salva e atualiza interface antes de dormir
                stateManager.forceSave();
                await updateProgressEmbed();
                
                await wait(pauseDuration);
                
                // Recalcula parâmetros para o próximo lote
                randomizeParameters();
                
                // Verifica se o bot foi parado durante a pausa
                if (!stateManager.state.active || stateManager.state.queue.length === 0) {
                    break;
                }
                
                sentInBatch = 0;
                currentBatchSize = getNextBatchSize();
            }

            // === 2. PREPARAÇÃO DO MEMBRO ===
            const userId = state.queue.shift(); // Remove o primeiro da fila
            await stateManager.modify(() => {}); // Trigger para salvar

            // Filtro de Segurança: Se já estiver na lista negra, pula sem tentar
            if (gd.blockedDMs && gd.blockedDMs.includes(userId)) {
                console.log(`⏭️ Pulando ID bloqueado anteriormente: ${userId}`);
                continue;
            }

            const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
            
            // Ignora Bots
            if (!user || user.bot) continue;

            // === 3. FILTRO HEURÍSTICO (NOVO) ===
            // Verifica se o membro parece suspeito (sem avatar + poucos cargos)
            let isSuspicious = false;
            try {
                const guild = client.guilds.cache.get(guildId);
                if (guild) {
                    const member = await guild.members.fetch(userId).catch(() => null);
                    // Se não tem avatar E só tem o cargo @everyone (size <= 1)
                    if (member && !user.avatar && member.roles.cache.size <= 1) {
                        isSuspicious = true;
                    }
                }
            } catch (e) {}

            // Se quiser ativar o pular suspeitos, descomente abaixo:
            /* if (isSuspicious) {
                console.log(`⚠️ Pulando conta suspeita (sem avatar/cargos): ${user.tag}`);
                continue;
            }
            */

            // === 4. ENVIO ===
            let imageSuccess = true;
            let textSuccess = true;
            let failureReason = null;

            // Envia anexos primeiro
            if (state.attachments && state.attachments.length > 0) {
                const result = await sendDM(user, { files: state.attachments });
                
                if (!result.success) {
                    imageSuccess = false;
                    failureReason = result.reason;
                    
                    // Se for quarentena, para TUDO imediatamente
                    if (result.reason === "quarantine") {
                        console.error("🚨 Worker interrompido por Quarentena (Anexo)");
                        await stateManager.modify(s => s.active = false);
                        await sendBackupEmail("Quarentena Detectada (Envio de Anexo)", stateManager.state);
                        break;
                    }
                }
            }

            // Envia texto se o anexo passou (ou se não tinha anexo)
            if (imageSuccess && state.text) {
                const content = getVariedText(state.text);
                const result = await sendDM(user, { content });
                
                if (!result.success) {
                    textSuccess = false;
                    failureReason = result.reason;
                    
                    if (result.reason === "quarantine") {
                        console.error("🚨 Worker interrompido por Quarentena (Texto)");
                        await stateManager.modify(s => s.active = false);
                        await sendBackupEmail("Quarentena Detectada (Envio de Texto)", stateManager.state);
                        break;
                    }
                }
            }

            const wasSuccess = imageSuccess && textSuccess;

            // === 5. ATUALIZAÇÃO DE ESTATÍSTICAS ===
            await stateManager.modify(s => {
                const gData = s.guildData[guildId];
                
                if (wasSuccess) {
                    s.currentRunStats.success++;
                    
                    // Remove da lista de falhas antiga se existir
                    if (gData && gData.failedQueue) {
                        const idx = gData.failedQueue.indexOf(userId);
                        if (idx > -1) gData.failedQueue.splice(idx, 1);
                    }
                } else {
                    if (failureReason === "closed") {
                        s.currentRunStats.closed++;
                        
                        // Adiciona à lista de bloqueio permanente
                        if (gData) {
                            if (!gData.blockedDMs.includes(userId)) gData.blockedDMs.push(userId);
                            // Adiciona aos processados para não tentar em !update
                            if (!gData.processedMembers.includes(userId)) gData.processedMembers.push(userId);
                        }
                    } else {
                        s.currentRunStats.fail++;
                        // Adiciona à fila de falhas para retentar depois
                        if (gData) {
                            if (!gData.failedQueue.includes(userId)) gData.failedQueue.push(userId);
                        }
                    }
                }
            });

            // === 6. PENALIDADE DE ERRO (NOVO) ===
            if (!wasSuccess) {
                // Se falhou, aplica uma pausa imediata para "esfriar" o sistema
                const penaltyTime = failureReason === "closed" ? 60000 : 30000; // 1 min se fechada, 30s outros
                console.warn(`⚠️ Falha no envio (${failureReason}). Aplicando pausa de penalidade de ${penaltyTime/1000}s...`);
                await wait(penaltyTime);
            }

            // === 7. DETECÇÃO DE SOFT-BAN ===
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
            
            // Delay normal apenas se foi sucesso (se falhou, já pagou a penalidade)
            if (wasSuccess) {
                await wait(currentDelayBase + Math.floor(Math.random() * DELAY_RANDOM_MS));
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
        // Tenta enviar backup se o erro for fatal
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
            .setTitle("📨 Envio em Andamento")
            .setColor("#00AEEF")
            .addFields(
                { name: "✅ Sucesso", value: `${state.currentRunStats.success}`, inline: true },
                { name: "❌ Falhas", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "🔒 Bloqueados", value: `${state.currentRunStats.closed}`, inline: true },
                { name: "⏳ Fila Atual", value: `${remaining}`, inline: true }
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
            .setTitle("📊 Status do Sistema")
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
            embed.addFields({ name: "⏰ Cooldown", value: cooldownInfo, inline: false });
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

            // 4. Heurística (Opcional): Pula membros sem avatar e sem cargos extras
            /* if (!m.user.avatar && m.roles.cache.size <= 1) return; 
            */

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

// ============================================================================
// INICIALIZAÇÃO (BOOTSTRAP)
// ============================================================================

client.on("ready", async () => {
    console.log(`✅ Bot online como: ${client.user.tag}`);
    
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