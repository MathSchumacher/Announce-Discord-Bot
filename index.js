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

// Detecta se estamos rodando em ambiente de nuvem (Render, Railway, Heroku) ou local
// Isso ajuda a ajustar os delays automaticamente (mais rápido localmente para testes)
const IS_CLOUD = !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT);
const IS_LOCAL = !IS_CLOUD;

// Email de destino para onde os backups de emergência serão enviados
const TARGET_EMAIL = process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com";

// ============================================================================
// ⚙️ 2. CONFIGURAÇÕES AVANÇADAS (V4.0 ROBUST & VERBOSE)
// ============================================================================

// 🛡️ CIRCUIT BREAKER & REJEIÇÃO (Proteção contra DMs fechadas)
// O sistema monitora falhas consecutivas para evitar que a conta seja marcada como spam.
// Se encontrar 3 DMs fechadas seguidas, o bot entra em "resfriamento".
const MAX_CONSECUTIVE_CLOSED = 3;           
const CLOSED_DM_COOLING_MS = 12 * 60 * 1000; // 12 minutos de resfriamento

// Analisa os últimos 50 envios para calcular a "saúde" da campanha atual
const REJECTION_WINDOW = 50;                
const REJECTION_RATE_WARNING = 0.30;        // 30% de erro = Modo Cautela (aumenta pausas)
const REJECTION_RATE_CRITICAL = 0.40;       // 40% de erro = Modo Crítico (pausas longas)

// ⏱️ LIMITES DE THROUGHPUT (Segurança da conta)
// O Discord tem limites de quantas ações podem ser feitas por hora.
const MAX_SENDS_PER_HOUR = 180;             // Teto seguro recomendado
const HOURLY_CHECK_INTERVAL = 10;           // Verifica limites a cada 10 envios

// ⏸️ PAUSAS PROGRESSIVAS (SISTEMA ANTI-QUARENTENA)
// Pausas automáticas entre lotes (batches) de mensagens para simular comportamento humano
const MIN_BATCH_PAUSE_MS = 3 * 60 * 1000;   // 3 min (Mínimo inicial)
const MAX_BATCH_PAUSE_MS = 8 * 60 * 1000;   // 8 min (Padrão)
const EXTENDED_PAUSE_MS = 15 * 60 * 1000;   // 15 min (Se taxa de erro estiver alta)
const ABSOLUTE_MAX_PAUSE_MS = 25 * 60 * 1000; // 25 min (Teto máximo absoluto)

// 💤 WATCHDOG & SEGURANÇA
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 min sem atividade = considera travado
const MIN_ACCOUNT_AGE_DAYS = 30;            // Ignora contas criadas há menos de 30 dias (provavelmente fakes)
const IGNORE_NO_AVATAR = true;              // Ignora usuários sem foto de perfil (filtro de qualidade)
const RETRY_LIMIT = 3;                      // Tenta enviar 3 vezes se der erro de rede (não erro de DM fechada)
const SAVE_THRESHOLD = 5;                   // Salva o estado no disco a cada 5 alterações (evita corrupção)

// 🎲 DELAYS & HUMANIZAÇÃO
const EXTRA_LONG_DELAY_CHANCE = 0.15;       // 15% de chance de uma pausa aleatória longa (simula ir ao banheiro/café)
const EXTRA_LONG_DELAY_MS = 25000;          // +25s nessa pausa longa

// 🧬 MEMÓRIA E CACHE
const MEMBER_CACHE_TTL = 5 * 60 * 1000;     // Cache de membros da guilda por 5 minutos

// ============================================================================
// 🧠 3. CONFIGURAÇÃO DA IA & SERVIÇOS EXTERNOS
// ============================================================================

// Configuração do Google Gemini (IA Generativa)
// Tenta usar a chave de API do ambiente. Se não existir, a IA fica desativada.
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
// Usa o modelo Flash 2.0 se disponível (mais rápido), ou fallback.
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" }) : null;

// Configuração do Nodemailer (Envio de Backup por Email)
// Essencial para recuperar o progresso se o bot cair durante a noite.
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
 * Calcula um tempo de "digitação" falso baseado no tamanho do texto.
 * Isso ajuda a enganar a detecção de bot do Discord, enviando o evento "Typing..."
 * * @param {string} text - O texto que será enviado
 * @returns {number} - Tempo em milissegundos para esperar
 */
function calculateTypingTime(text) {
    if (!text) return 1500;
    // Assume uma velocidade média de digitação humana (~15 caracteres por segundo)
    const ms = (text.length / 15) * 1000;
    // Clampa o valor entre 2.5s e 9s para não ficar nem muito rápido nem muito lento
    return Math.min(9000, Math.max(2500, ms));
}

/**
 * Verifica se a conta alvo parece ser um bot, spammer ou fake.
 * Baseado na data de criação e presença de avatar.
 * * @param {User} user - Objeto de usuário do Discord
 * @returns {boolean} - True se for suspeito, False se for seguro
 */
function isSuspiciousAccount(user) {
    // Cálculo da idade da conta em dias
    const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    
    // Regra 1: Contas muito novas são arriscadas
    if (ageInDays < MIN_ACCOUNT_AGE_DAYS) return true;
    
    // Regra 2: Contas sem avatar geralmente são bots ou descartáveis
    if (IGNORE_NO_AVATAR && !user.avatar) return true;
    
    return false;
}

/**
 * Parseia os filtros passados no comando /announce.
 * Extrai IDs para ignorar (-) ou para focar (+), e detecta a flag 'force'.
 * * @param {string} text - Texto bruto do comando
 * @returns {object} - Objeto com texto limpo e Sets de filtros
 */
function parseSelectors(text) {
    const ignore = new Set();
    const only = new Set();
    
    // Regex para capturar IDs com prefixo + ou -
    // Exemplo: -123456789 (ignorar) ou +987654321 (apenas este)
    const regex = /([+-])\{(\d{5,30})\}/g;
    let m;
    while ((m = regex.exec(text))) {
        if (m[1] === '-') ignore.add(m[2]);
        if (m[1] === '+') only.add(m[2]);
    }
    
    // Remove os IDs do texto para sobrar a mensagem limpa
    const cleaned = text.replace(regex, "").trim();
    // Verifica se tem a palavra "force" (case insensitive)
    const hasForce = /\bforce\b/i.test(cleaned);
    
    return { 
        cleaned: hasForce ? cleaned.replace(/\bforce\b/i, '').trim() : cleaned, 
        ignore, 
        only, 
        hasForce 
    };
}

/**
 * Baixa e valida o arquivo JSON de backup enviado no anexo.
 * Essencial para o comando /resume funcionar com arquivos externos.
 * * @param {string} url - URL do anexo do Discord
 * @returns {Promise<object>} - Resultado com sucesso ou erro
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
                    // Validação básica se parece um backup nosso
                    if (!parsed.remainingQueue && !parsed.queue && !parsed.stats) {
                         resolve({ success: false, error: "❌ JSON inválido: Formato desconhecido." });
                    } else {
                         resolve({ success: true, state: parsed });
                    }
                } catch (e) {
                    resolve({ success: false, error: "❌ O arquivo não é um JSON válido ou está corrompido." });
                }
            });
        }).on('error', (err) => resolve({ success: false, error: `Erro de download: ${err.message}` }));
    });
}

/**
 * Usa IA (Gemini) para reescrever uma pequena parte do texto (Variação Anti-Spam).
 * * 🔥 CORREÇÃO V4: Prompt reforçado para garantir que o idioma de saída
 * seja IDÊNTICO ao idioma de entrada, evitando traduções indesejadas.
 * * @param {string} originalText - Texto base
 * @param {string} globalname - Nome do usuário para personalização
 * @returns {Promise<string>} - Texto com variação
 */
async function getAiVariation(originalText, globalname) {
    // Substituição básica de variáveis locais antes de enviar para a IA
    let finalText = originalText.replace(/\{name\}|\{username\}|\{nome\}/gi, globalname);
    
    // Se não tem IA configurada ou texto é muito curto, retorna sem variação
    if (!model || finalText.length < 10) return finalText;

    try {
        const safeGlobalName = globalname.replace(/["{}\\]/g, '');
        // Prompt Engenheirado para manter idioma e estrutura
        const prompt = `
        ROLE: You are a strict synonym replacement engine.
        TASK: Identify ONE word or short expression (max 2 words) in the provided text and replace it with a contextual synonym.
        
        ⚠️ MANDATORY RULES:
        1. DETECT the language of the input text (Portuguese, English, Spanish, etc.).
        2. The "substituto" MUST be in the EXACT SAME LANGUAGE as the input text. Do NOT translate.
        3. Do NOT change links, formatting (bold, italics), or special variables.
        4. Output JSON ONLY: { "alvo": "original_word", "substituto": "synonym" }
        
        Input Text: """${finalText}"""
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response.text();
        
        // Limpa formatação Markdown do JSON se a IA adicionar (```json ...)
        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(jsonStr);

        // Verifica se a palavra alvo realmente existe no texto antes de trocar (segurança)
        if (data.alvo && data.substituto && finalText.includes(data.alvo)) {
            return finalText.replace(data.alvo, data.substituto);
        }
        return finalText;
    } catch (error) {
        // Se der erro na IA, retorna o texto original (Fail-safe silencioso)
        return finalText;
    }
}

// ============================================================================
// 💾 5. GERENCIADOR DE ESTADO (STATE MANAGER)
// ============================================================================

class StateManager {
    constructor(filePath, botId) {
        this.filePath = filePath;
        this.botId = botId;
        this.state = this.load();
        this.saveQueue = Promise.resolve(); // Fila para evitar escritas simultâneas no disco
        this.unsavedChanges = 0;
    }

    /**
     * Retorna o objeto de estado padrão (Vazio).
     * Usado na primeira execução ou se o arquivo estiver corrompido.
     */
    getInitialState() {
        return {
            active: false,
            text: "",
            attachments: [],
            ignore: new Set(),
            only: new Set(),
            queue: [], // Fila de execução imediata (IDs)
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            quarantine: false, // Flag de parada de emergência (API 40003)
            currentAnnounceGuildId: null,
            privacyMode: "public",
            initiatorId: null,
            guildData: {} // Dados persistentes por servidor (blockedDMs, histórico, pendentes)
        };
    }

    /**
     * Carrega estado do disco. Se falhar, inicia novo.
     * 🔥 V4: Inclui auto-correção se o bot estiver travado como "Ativo".
     */
    load(initialState = null) {
        const stateToLoad = initialState || this.getInitialState();
        try {
            // Se foi passado um estado inicial (ex: via anexo), usa ele. Senão, lê do disco.
            const raw = initialState ? JSON.stringify(initialState) : fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            const loaded = Object.assign(stateToLoad, parsed);

            // Reconverte Arrays para Sets (JSON não suporta Sets nativamente)
            loaded.ignore = new Set(Array.isArray(loaded.ignore) ? loaded.ignore : []);
            loaded.only = new Set(Array.isArray(loaded.only) ? loaded.only : []);

            // Garante estrutura do guildData para evitar crash em atualizações
            for (const guildId in loaded.guildData) {
                const gd = loaded.guildData[guildId];
                gd.processedMembers = Array.isArray(gd.processedMembers) ? gd.processedMembers : [];
                gd.blockedDMs = Array.isArray(gd.blockedDMs) ? gd.blockedDMs : [];
                gd.failedQueue = Array.isArray(gd.failedQueue) ? gd.failedQueue : [];
                gd.pendingQueue = Array.isArray(gd.pendingQueue) ? gd.pendingQueue : [];
            }

            // 🛠️ AUTO-CORREÇÃO DE BOOT:
            // Se o estado carregado diz que está "active: true" mas a fila está vazia,
            // significa que o bot crashou ou foi desligado incorretamente.
            // Resetamos para false para evitar o erro "❌ Ocupado".
            if (loaded.active && (!loaded.queue || loaded.queue.length === 0)) {
                console.log(`[Bot ${this.botId}] ⚠️ Estado corrigido: Bot estava marcado como ativo, mas fila vazia. Resetando para inativo.`);
                loaded.active = false;
            }

            return loaded;
        } catch (e) {
            console.log(`[Bot ${this.botId}] ℹ️ Nenhum estado anterior encontrado ou erro de leitura. Criando novo.`);
            return this.getInitialState();
        }
    }

    /**
     * Salva o estado atual no disco (JSON).
     * Converte Sets para Arrays antes de salvar.
     */
    save() {
        try {
            const serializable = {
                ...this.state,
                ignore: [...this.state.ignore],
                only: [...this.state.only],
                guildData: {}
            };
            // Serializa guildData profundamente
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
            console.error(`[Bot ${this.botId}] ❌ Erro ao salvar estado no disco:`, e.message);
        }
    }

    /**
     * Modifica o estado com segurança de concorrência.
     * Usa uma fila de Promises para garantir que leituras/escritas não colidam.
     */
    async modify(callback) {
        return this.saveQueue = this.saveQueue.then(async () => {
            callback(this.state);
            this.unsavedChanges++;
            // Salva periodicamente para não desgastar o disco (IOPS)
            if (this.unsavedChanges >= SAVE_THRESHOLD) this.save();
        });
    }

    /**
     * Força o salvamento imediato (usado em shutdowns ou erros críticos).
     */
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
        this.id = id; // ID numérico da instância (1, 2, 3...)
        this.stateManager = new StateManager(path.resolve(__dirname, `state_${id}.json`), id);
        
        // --- VARIÁVEIS DE CONTROLE DINÂMICO ---
        
        // Delays Iniciais (Variam por ID para evitar que múltiplos bots sincronizem perfeitamente)
        this.currentDelayBase = (IS_LOCAL ? 2000 : 12000) + (id * 300); 
        this.currentBatchBase = IS_LOCAL ? 5 : 12;
        
        // Monitoramento de Taxas & Métricas de Sessão
        // IMPORTANTE: Reiniciam a cada boot para evitar loop de espera baseado em dados antigos
        this.recentResults = [];    // Array circular (últimos 50 resultados)
        this.sendsThisHour = 0;     // Contador horário
        this.hourlyResetTime = Date.now() + 3600000;
        this.pauseMultiplier = 1.0; // Multiplicador de pausa adaptativa
        this.batchCounter = 0;      // Contador de lotes
        
        // Watchdog & Controle
        this.lastActivityTime = Date.now();
        this.workerRunning = false;
        this.progressUpdaterHandle = null;

        // Cliente Discord.js com Intents necessários
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
     * Wait seguro e INTERRUPTÍVEL.
     * 🔥 CORREÇÃO V4: Verifica se o bot está ativo a cada segundo.
     * Se o usuário der /stop, sai do loop imediatamente, sem esperar o tempo acabar.
     */
    async wait(ms) {
        this.lastActivityTime = Date.now();
        
        // Pausa curta (menos de 5s), espera direto
        if (ms < 5000) return new Promise(r => setTimeout(r, ms));
        
        const seconds = Math.ceil(ms / 1000);
        
        if (seconds > 60) {
            console.log(`[Bot ${this.id}] 💤 Iniciando espera longa de ${(seconds/60).toFixed(1)} min.`);
        }

        for (let i = 0; i < seconds; i++) {
            // CHECK DE SEGURANÇA: Se o usuário deu STOP, interrompe a espera imediatamente
            if (!this.stateManager.state.active || this.stateManager.state.quarantine) {
                return; 
            }

            await new Promise(r => setTimeout(r, 1000));
            this.lastActivityTime = Date.now(); // Heartbeat para o Watchdog não matar o processo

            // Log opcional de progresso
            // if (seconds > 120 && (i+1) % 60 === 0) { console.log(`[Bot ${this.id}] ...aguardando...`); }
        }
    }

    /**
     * Randomiza parâmetros para evitar padrões (Anti-Fingerprinting).
     * Troca os delays base e tamanho do lote.
     */
    randomizeParameters() {
        if (IS_LOCAL) {
            this.currentDelayBase = 2000 + Math.random() * 2000;
            this.currentBatchBase = 5 + Math.floor(Math.random() * 5);
        } else {
            // V4: Delays mais seguros e humanos
            this.currentDelayBase = 12000 + Math.floor(Math.random() * 10000);
            this.currentBatchBase = 12 + Math.floor(Math.random() * 10);
        }
        console.log(`[Bot ${this.id}] 🎲 Novos Params: Delay ~${(this.currentDelayBase/1000).toFixed(1)}s | Lote ${this.currentBatchBase}`);
    }

    /**
     * Analisa taxa de rejeição (últimos 50 envios).
     * Define o status de saúde da campanha.
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
     * Adiciona resultado ao histórico circular.
     */
    addResult(type) {
        this.recentResults.push(type);
        if (this.recentResults.length > REJECTION_WINDOW) this.recentResults.shift();
    }

    /**
     * Verifica o limite de 180 envios/hora.
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
     * Garante que o objeto de dados da guilda exista no estado.
     */
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

    /**
     * Envia o backup por e-mail quando o bot para ou trava.
     */
    async sendBackupEmail(reason, state) {
        console.log(`[Bot ${this.id}] 📧 Preparando backup de emergência. Motivo: ${reason}`);
        const guildId = state.currentAnnounceGuildId;
        const gd = guildId ? this.ensureGuildData(guildId) : null;
        
        // Coleta quem falta enviar (Queue atual + Pendentes + Falhas)
        let remainingUsers = [...state.queue];
        if (gd) {
            const allPending = [...state.queue, ...gd.pendingQueue, ...gd.failedQueue];
            remainingUsers = [...new Set(allPending)].filter(id => !gd.blockedDMs.includes(id));
        }

        if (remainingUsers.length === 0) return;

        const backupData = {
            source: `StealthBot_Instance_${this.id}_V4.0`,
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
            text: `O sistema parou.\nMotivo: ${reason}\nRestantes: ${remainingUsers.length}\n\nCOMO RETOMAR:\nUse o comando /resume e anexe este arquivo JSON.`,
            attachments: [{ filename: `backup_${Date.now()}.json`, content: jsonContent }]
        };

        try { 
            await transporter.sendMail(mailOptions);
            console.log(`[Bot ${this.id}] ✅ E-mail de backup enviado com sucesso.`);
        } catch (e) { 
            console.error(`[Bot ${this.id}] ❌ Falha envio email:`, e.message); 
        }
    }

    /**
     * Envia mensagem para um único usuário com tratamento de erro completo.
     */
    async sendStealthDM(user, rawText, attachments) {
        this.lastActivityTime = Date.now(); // Heartbeat

        // 1. Cria ou recupera DM
        let dmChannel;
        try {
            if (user.dmChannel) dmChannel = user.dmChannel;
            else dmChannel = await user.createDM();
        } catch (e) { return { success: false, reason: "closed" }; }

        // 2. IA Variation (Com proteção de idioma)
        let finalContent = rawText;
        if (rawText) {
            const userDisplay = user.globalName || user.username || "amigo";
            finalContent = await getAiVariation(rawText, userDisplay);
        }

        // 3. Typing Simulation
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

        // 4. Tentativa de envio com retry (para erros de rede)
        for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
            try {
                await dmChannel.send(payload);
                console.log(`[Bot ${this.id}] ✅ Enviado para ${user.tag}`);
                return { success: true };
            } catch (err) {
                const errMsg = (err.message || "").toLowerCase();
                const code = err.code || 0;

                // CRITICAL: Spam Flag do Discord
                if (code === 40003 || errMsg.includes("spam") || errMsg.includes("quarantine")) {
                    console.error(`[Bot ${this.id}] 🚨 ALERTA CRÍTICO: SPAM FLAG (40003)`);
                    return { success: false, reason: "quarantine" };
                }

                // DM Fechada
                if (code === 50007 || code === 50001) return { success: false, reason: "closed" };

                // Rate Limit Temporário
                if (err.retry_after || code === 20016) {
                    const waitTime = (err.retry_after ? err.retry_after * 1000 : 60000) + 5000;
                    if (waitTime > 3600000) return { success: false, reason: "quarantine" };
                    console.warn(`[Bot ${this.id}] ⏳ Rate Limit. Esperando ${waitTime/1000}s.`);
                    await this.wait(waitTime);
                    continue;
                }

                // Erro genérico (rede, timeout)
                const backoff = 5000 * attempt;
                if (attempt < RETRY_LIMIT) await this.wait(backoff);
            }
        }
        return { success: false, reason: "fail" };
    }

    // ========================================================================
    // 🏭 7. WORKER LOOP (V4.0 - ANTI-LOOP DEFENSIVO)
    // ========================================================================

    async workerLoop() {
        console.log(`[Bot ${this.id}] 🚀 Worker Iniciado - V4.0 (Anti-Loop Fix)`);
        const state = this.stateManager.state;
        const guildId = state.currentAnnounceGuildId;

        // Validações
        if (!guildId) { await this.stateManager.modify(s => s.active = false); return; }
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { await this.stateManager.modify(s => s.active = false); return; }
        const gd = this.ensureGuildData(guildId);
        
        let sentInBatch = 0;
        let currentBatchSize = this.currentBatchBase;
        
        // 🔥 CORREÇÃO CRÍTICA DO LOOP: Inicializa sempre zerado
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
                        // Lógica Adaptativa
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

                    console.log(`[Bot ${this.id}] 🔄 Lote ${this.batchCounter} fim. Pausa: ${(pauseDuration/60000).toFixed(1)} min.`);
                    
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
                    // Usuário não existe mais, registra como processado mas não conta falha
                    if (!gd.processedMembers.includes(userId)) gd.processedMembers.push(userId);
                    continue;
                }

                // Verifica lista negra local
                if (gd.blockedDMs && gd.blockedDMs.includes(userId)) continue;

                let user = this.client.users.cache.get(userId);
                if (!user) {
                    try { user = await this.client.users.fetch(userId); } catch (e) { continue; }
                }

                // Segurança Anti-Bot
                if (user.bot || isSuspiciousAccount(user)) {
                    console.log(`[Bot ${this.id}] 🚫 Ignorado (Suspeito): ${user.tag}`);
                    continue;
                }

                // Limite Horário
                if (sentInBatch > 0 && sentInBatch % HOURLY_CHECK_INTERVAL === 0) {
                    const limitCheck = this.checkHourlyLimit();
                    if (limitCheck.exceeded) {
                        console.warn(`[Bot ${this.id}] ⏱️ Limite horário. Aguardando ${(limitCheck.waitTime/60000).toFixed(1)} min...`);
                        await this.updateProgressEmbed();
                        await this.wait(limitCheck.waitTime);
                    }
                }

                // 🚀 ENVIO
                const result = await this.sendStealthDM(user, state.text, state.attachments);

                // Registra métricas
                if (result.success) this.addResult('success');
                else if (result.reason === 'closed') this.addResult('closed');
                else this.addResult('fail');

                await this.stateManager.modify(s => {
                    const g = this.ensureGuildData(guildId);
                    
                    if (result.success) {
                        s.currentRunStats.success++;
                        consecutiveClosedCount = 0;
                        // Remove da lista de falhas se por acaso estiver lá
                        const idx = g.failedQueue.indexOf(userId);
                        if (idx > -1) g.failedQueue.splice(idx, 1);
                    } else if (result.reason === 'closed') {
                        s.currentRunStats.closed++;
                        consecutiveClosedCount++;
                        if (!g.blockedDMs.includes(userId)) g.blockedDMs.push(userId);
                    } else if (result.reason === 'quarantine') {
                        s.active = false;
                        s.quarantine = true;
                    } else {
                        s.currentRunStats.fail++;
                        consecutiveClosedCount = 0;
                        if (!g.failedQueue.includes(userId)) g.failedQueue.push(userId);
                    }
                    if (!g.processedMembers.includes(userId)) g.processedMembers.push(userId);
                });

                // -----------------------------------------------------------
                // ⚡ CIRCUIT BREAKER (RESFRIAMENTO COM RESET)
                // -----------------------------------------------------------
                if (consecutiveClosedCount >= MAX_CONSECUTIVE_CLOSED) {
                    console.warn(`[Bot ${this.id}] 🛡️ ALERTA: ${consecutiveClosedCount} DMs fechadas seguidas. Resfriando ${CLOSED_DM_COOLING_MS/60000} min...`);
                    await this.updateProgressEmbed();
                    
                    await this.wait(CLOSED_DM_COOLING_MS); 
                    
                    // 🔥 CORREÇÃO: RESET TOTAL DE MÉTRICAS
                    // Isso garante que ele não entre em pausa de novo assim que voltar
                    consecutiveClosedCount = 0; 
                    this.recentResults = []; // Limpa o histórico "sujo"
                    sentInBatch = 0;         // Reseta o lote atual
                    
                    console.log(`[Bot ${this.id}] ❄️ Resfriamento concluído. Métricas resetadas.`);
                }

                if (state.quarantine) {
                    await this.sendBackupEmail("Quarentena Detectada (API Flag 40003)", state);
                    break;
                }

                await this.updateProgressEmbed().catch(() => {});

                // Delays Pós-Envio
                if (result.success) {
                    let d = this.currentDelayBase + Math.floor(Math.random() * 8000);
                    if (Math.random() < EXTRA_LONG_DELAY_CHANCE) {
                        d += (IS_LOCAL ? 5000 : EXTRA_LONG_DELAY_MS);
                        console.log(`[Bot ${this.id}] 💭 Pausa extra natural...`);
                    }
                    await this.wait(d);
                } else {
                    // Se falhou, espera um pouco mais
                    let penalty = result.reason === 'closed' ? 2000 : 10000;
                    await this.wait(penalty);
                }
                
                // Só incrementa batch se REALMENTE tentou enviar
                sentInBatch++;

            } // Fim While

            if (state.queue.length === 0 && state.active) {
                console.log(`[Bot ${this.id}] ✅ Fim da Fila.`);
                await this.finalizeSending();
            }

        } catch (err) {
            console.error(`[Bot ${this.id}] 💥 Erro Worker:`, err);
            await this.sendBackupEmail(`Erro Crítico: ${err.message}`, state);
        } finally {
            this.workerRunning = false;
            if (this.stateManager.state.queue.length > 0 && (!this.stateManager.state.active)) {
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
        });
    }

    // ========================================================================
    // 📊 8. FINALIZAÇÃO E UPDATE DE UI (PAINEL 4 COLUNAS)
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

        if (s.quarantine) embed.addFields({ name: "🚨 STATUS", value: "QUARENTENA (STOP)", inline: false });
        const finalText = remaining === 0 ? "✅ Finalizado!" : `⏸️ Parado. Restam ${remaining}.`;

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

    // PAINEL UNIFICADO (MESMO LAYOUT DO RELATÓRIO)
    async updateProgressEmbed() {
        const s = this.stateManager.state;
        if (!s.progressMessageRef) return;
        try {
            const ch = await this.client.channels.fetch(s.progressMessageRef.channelId);
            const msg = await ch.messages.fetch(s.progressMessageRef.messageId);
            
            const remaining = s.queue.length;

            const embed = new EmbedBuilder()
                .setTitle(`📨 Bot ${this.id}: Enviando...`)
                .setColor("#00AEEF") // Azul durante envio
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
    // 🕹️ 9. COMANDOS (SLASH & CHAT)
    // ========================================================================

    async handleAnnounce(ctx, text, attachmentUrl, filtersStr) {
        const s = this.stateManager.state;
        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;
        
        if (s.active) return isSlash ? ctx.reply({content: "❌ Ocupado. Use !reset se travou.", ephemeral: true}) : ctx.reply("❌ Ocupado.");

        const guildId = ctx.guild.id;
        const gd = this.ensureGuildData(guildId);
        
        const parsed = parseSelectors(filtersStr || "");
        let messageText = parsed.cleaned || text || "";
        
        if (isSlash && messageText) {
            messageText = messageText.replace(/ {2,}/g, '\n\n').replace(/ ([*•+]) /g, '\n$1 ').replace(/\n /g, '\n');
        }

        if (!messageText && !attachmentUrl) return isSlash ? ctx.reply({content: "❌ Texto ou anexo obrigatório.", ephemeral: true}) : ctx.reply("❌ Texto ou anexo obrigatório.");

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
        
        const members = await ctx.guild.members.fetch();
        const queue = [];
        members.forEach(m => {
            if (m.user.bot) return;
            if (gd.blockedDMs.includes(m.id)) return;
            if (parsed.only.size > 0 && !parsed.only.has(m.id)) return;
            if (parsed.ignore.has(m.id)) return;
            queue.push(m.id);
        });

        if (queue.length === 0) return isSlash ? ctx.editReply("❌ Ninguém encontrado.") : ctx.reply("❌ Ninguém encontrado.");

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

    async handleResume(ctx, attachmentUrl) {
        if (this.stateManager.state.active) return ctx.reply("⚠️ Já ativo.");
        const isSlash = ctx.isChatInputCommand?.();
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

        if (attachmentUrl) {
            const jsonResult = await readAttachmentJSON(attachmentUrl);
            if (!jsonResult.success) return ctx.reply(jsonResult.error);
            await this.stateManager.modify(s => Object.assign(s, jsonResult.state));
        }

        const s = this.stateManager.state;
        const gd = this.ensureGuildData(ctx.guild.id);
        
        const allIds = [...new Set([...s.queue, ...gd.pendingQueue, ...gd.failedQueue])].filter(id => !gd.blockedDMs.includes(id));

        if (allIds.length === 0) return ctx.reply("✅ Nada para retomar.");

        await this.stateManager.modify(st => {
            st.active = true;
            st.quarantine = false;
            st.currentAnnounceGuildId = ctx.guild.id;
            st.queue = allIds;
            st.text = s.text || gd.lastRunText;
            st.attachments = (s.attachments && s.attachments.length) ? s.attachments : gd.lastRunAttachments || [];
            st.currentRunStats = { success: 0, fail: 0, closed: 0 };
            st.initiatorId = initiatorId;
            st.privacyMode = isSlash ? 'private' : 'public';
            const g = this.ensureGuildData(ctx.guild.id);
            g.pendingQueue = [];
            g.failedQueue = [];
        });

        const infoMsg = `🔄 [Bot ${this.id}] Retomando...`;

        if (isSlash) {
            await ctx.deferReply({ephemeral: true});
            try {
                const user = await ctx.user.createDM();
                const embed = new EmbedBuilder().setTitle(`Bot ${this.id} Retomado`).setDescription("...");
                const dmMsg = await user.send({ content: infoMsg, embeds: [embed] });
                await this.stateManager.modify(st => { st.progressMessageRef = { channelId: dmMsg.channel.id, messageId: dmMsg.id }; });
                await ctx.editReply("✅ Retomado! DM.");
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
                } else if (commandName === 'stop') {
                    await interaction.deferReply({ephemeral: true});
                    await this.stateManager.modify(s => s.active = false);
                    await this.sendBackupEmail("Stop Manual Slash", this.stateManager.state);
                    await interaction.editReply("🛑 Parado.");
                } else if (commandName === 'status') {
                    const s = this.stateManager.state;
                    const rate = this.analyzeRejectionRate().rate * 100;
                    const embed = new EmbedBuilder().setTitle(`Status Bot ${this.id}`)
                        .addFields(
                            { name: "Active", value: `${s.active}`, inline: true },
                            { name: "Queue", value: `${s.queue.length}`, inline: true },
                            { name: "Rejection", value: `${rate.toFixed(1)}%`, inline: true }
                        );
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
            } else if (cmd === 'stop') {
                await this.stateManager.modify(s => s.active = false);
                message.reply("🛑 Parado.");
            } else if (cmd === 'reset') { // COMANDO DE EMERGÊNCIA NOVO
                await this.stateManager.modify(s => { s.active = false; s.queue = []; });
                message.reply("🔄 Reset Forçado. Bot desbloqueado.");
            }
        });

        await this.client.login(this.token);
    }
}

// ============================================================================
// 🏭 10. INICIALIZADOR DE MÚLTIPLAS INSTÂNCIAS
// ============================================================================

const bots = [];
function loadBots() {
    let index = 1;
    // Loop infinito procurando tokens no .env (DISCORD_TOKEN, DISCORD_TOKEN2...)
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

// ============================================================================
// 🌍 11. SERVIDOR HTTP (MONITORAMENTO & ANTI-FREEZE)
// ============================================================================

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const botStatus = bots.map(b => ({
        id: b.id,
        active: b.stateManager.state.active,
        queue: b.stateManager.state.queue.length,
        success: b.stateManager.state.currentRunStats.success
    }));
    res.end(JSON.stringify({ status: "online", system: "V4.0 Final", bots: botStatus }));
});
server.listen(PORT, () => {
    console.log(`\n🛡️ SYSTEM V4.0 STARTED | PORT ${PORT}`);
    loadBots();
});

// Tratamento de encerramento seguro
process.on('SIGINT', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });
process.on('SIGTERM', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    bots.forEach(b => b.stateManager.forceSave());
});