/**
 * ============================================================================
 * PROJECT: DISCORD MASS DM BOT - V32.0 EMOJI-SAFE EDITION
 * ARCHITECTURE: V31.0 Core + Regex Fix for Inline Emojis
 * AUTHOR: Matheus Schumacher & Gemini Engineering Team
 * DATE: December 2025
 * * [CHANGELOG V32.0]
 * 1. FIX: 'parseSlashInput' updated to prevent inline emojis breaking lines.
 * 2. REGEX: Bullet point detection is now strict (Start of Line Only).
 * 3. STABLE: All V31 features (Live Panel, Anti-Ban, Multi-Bot) preserved.
 * ============================================================================
 */

require("dotenv").config();

// ============================================================================
// 📦 MÓDULOS
// ============================================================================
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder,
    ActivityType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    Events,
    MessageFlags
} = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================================
// ⚙️ 1. CONFIGURAÇÃO CENTRAL
// ============================================================================

const CONFIG = {
    // --- Identidade & Infraestrutura ---
    TARGET_EMAIL: process.env.TARGET_EMAIL || "matheusmschumacher@gmail.com",
    CONTROL_CHANNEL_ID: process.env.CONTROL_CHANNEL_ID,
    TIMEZONE: process.env.TZ || "America/Sao_Paulo",
    IS_CLOUD: !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT),
    HTTP_PORT: process.env.PORT || 8080,
    
    // --- Segurança & Circuit Breakers ---
    THRESHOLDS: {
        CONSECUTIVE_CLOSED_DMS: 3,     
        CONSECUTIVE_NET_ERRORS: 5,     
        REQUIRED_SUCCESS_TO_RESET: 5,  
        CRITICAL_REJECTION_RATE: 0.4,  
        SOFT_BAN_THRESHOLD: 0.25,      
        SOFT_BAN_MIN_SAMPLES: 20       
    },
    
    // --- Timings & Cooling (ms) ---
    CLOSED_DM_COOLING_MS: 20 * 60 * 1000, 
    MAX_SENDS_PER_HOUR: 90,           
    INACTIVITY_THRESHOLD: 120 * 1000, 
    STATE_SAVE_DEBOUNCE_MS: 5000,        
    
    // --- Filtros ---
    SAFE_MODE: false, 
    MIN_ACCOUNT_AGE_DAYS: 30,
    IGNORE_NO_AVATAR: true,
    MAX_RETRIES: 3,
    MEMBER_CACHE_TTL: 10 * 60 * 1000, 
    
    // --- Humanização ---
    PEAK_HOUR_START: 18,
    PEAK_HOUR_END: 23,
    BATCH_SIZE_MIN: 6,
    BATCH_SIZE_MAX: 10,
    WPM_MEAN: 55, 
    WPM_DEV: 15,
    
    // --- Memória ---
    MAX_STATE_HISTORY: 1000,
    MAX_AI_CACHE_SIZE: 1000, 
    
    // --- Pausas (Minutes) - Adaptive ---
    PAUSE_NORMAL: { MIN: 3, MAX: 8 },
    PAUSE_CAUTION: { MIN: 8, MAX: 15 },
    PAUSE_CRITICAL: { MIN: 15, MAX: 30 },

    // --- Sleep Cycle ---
    SLEEP_START_HOUR: 3, 
    SLEEP_END_HOUR: 8
};

// ============================================================================
// 🛠️ 2. UTILITÁRIOS & FORMATAÇÃO
// ============================================================================

const Utils = {
    // 🔥 V32.0: EMOJI-SAFE FORMATTER
    parseSlashInput: (text) => {
        if (!text) return "";
        let str = String(text);

        // 1. Normalizar quebras de linha literais
        str = str.replace(/\\n/g, '\n');

        // 2. Preservar Headers (#, ##, ###)
        // Garante que headers tenham uma linha vazia antes, a menos que seja a primeira linha
        str = str.replace(/([^\n])\s*(#+ )/g, '$1\n\n$2');
        str = str.replace(/^\s*(#+ )/g, '$1');

        // 3. 🔥 FIX: Preservar Bullets APENAS no início da linha
        // Impede que emojis no meio do texto sejam quebrados
        str = str.replace(/(\n|^)\s*([-*•+➦➜→=>])\s+/gm, '$1$2 ');

        // 4. Limpeza de Espaços
        // Remove excesso de quebras (>2) para evitar buracos, mas mantém parágrafos
        str = str.replace(/\n{3,}/g, '\n\n');
        
        return str.trim();
    },

    personalizeText: (template, user) => {
        if (!template) return "";
        const safeTemplate = String(template);
        const displayName = user.globalName || user.username || "amigo";
        const safeName = displayName.replace(/[*_`~|@#\\]/g, '');
        return safeTemplate.replace(/\{name\}|\{username\}|\{nome\}/gi, safeName);
    },

    sanitizeString: (input) => {
        if (!input) return "";
        if (typeof input === 'string') return input;
        if (typeof input === 'object') {
            return input.text || input.message || input.content || input.variation || JSON.stringify(input);
        }
        return String(input);
    },

    isPeakHour: () => {
        const date = new Date();
        const hourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: CONFIG.TIMEZONE }).format(date);
        const hour = parseInt(hourStr, 10);
        return hour >= CONFIG.PEAK_HOUR_START && hour <= CONFIG.PEAK_HOUR_END;
    },
    
    isSleepTime: () => {
        const date = new Date();
        const hourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: CONFIG.TIMEZONE }).format(date);
        const hour = parseInt(hourStr, 10);
        return hour >= CONFIG.SLEEP_START_HOUR && hour < CONFIG.SLEEP_END_HOUR;
    },

    getNextSleepTimestamp: () => {
        const now = new Date();
        const timeString = now.toLocaleString("en-US", { timeZone: CONFIG.TIMEZONE });
        const localDate = new Date(timeString);
        const targetDate = new Date(localDate);
        targetDate.setHours(CONFIG.SLEEP_START_HOUR, 0, 0, 0);
        if (targetDate <= localDate) targetDate.setDate(targetDate.getDate() + 1);
        const diff = targetDate.getTime() - localDate.getTime();
        return Date.now() + diff;
    },

    getWakeTime: () => {
        const now = new Date();
        const timeString = now.toLocaleString("en-US", { timeZone: CONFIG.TIMEZONE });
        const localDate = new Date(timeString);
        const wakeDate = new Date(localDate);
        wakeDate.setHours(CONFIG.SLEEP_END_HOUR, 0, 0, 0);
        if (wakeDate <= localDate) wakeDate.setDate(wakeDate.getDate() + 1);
        return wakeDate.getTime() - localDate.getTime();
    },

    calculateHumanDelay: () => {
        let u = 0, v = 0;
        while(u === 0) u = Math.random();
        while(v === 0) v = Math.random();
        const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        const mu = 3.8; 
        const sigma = 0.8;
        let delay = Math.exp(mu + sigma * z) * 1000;
        if (Utils.isPeakHour()) delay *= (1.2 + Math.random() * 0.5);
        return Math.floor(Math.max(12000, delay));
    },

    isValidUrl: (string) => {
        if (!string) return false;
        try { const url = new URL(string); return url.protocol === "http:" || url.protocol === "https:"; } catch (_) { return false; }
    },

    getPoissonInterval: (meanTimeMs) => {
        const lambda = 1 / meanTimeMs;
        return -Math.log(1 - Math.random()) / lambda;
    },

    generateClientSpoof: () => {
        const osList = ["Windows", "macOS", "Linux"];
        const browsers = ["Discord Client", "Chrome", "Firefox"];
        return {
            os: osList[Math.floor(Math.random() * osList.length)],
            browser: browsers[Math.floor(Math.random() * browsers.length)],
            release_channel: "stable",
            client_version: "1.0.9015",
            os_version: "10.0.0",
            device: "Desktop",
            system_locale: "pt-BR",
            client_build_number: 100000 + Math.floor(Math.random() * 50000)
        };
    },

    checkAccountStatus: (user) => {
        if (!CONFIG.SAFE_MODE) return { safe: true }; 
        const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
        if (ageInDays < CONFIG.MIN_ACCOUNT_AGE_DAYS) return { safe: false, reason: `Too New (${ageInDays.toFixed(1)} days)` };
        if (CONFIG.IGNORE_NO_AVATAR && !user.avatar) return { safe: false, reason: "No Avatar" };
        return { safe: true };
    },
    
    isSuspiciousAccount: (user) => !Utils.checkAccountStatus(user).safe,

    parseSelectors: (text) => {
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
        // For commands !announce, we return clean text
        // For slash commands, we will rely on parseSlashInput later
        return { cleaned: finalCleaned(cleaned), ignore, only, hasForce };
    },

    cleanText: (text) => {
        return text.replace(/([+-])\{(\d{5,30})\}/g, '').replace(/\bforce\b/i, '').trim();
    },

    fetchJsonFromUrl: (url) => {
        if (!Utils.isValidUrl(url)) return Promise.resolve({ success: false, error: "Invalid URL" });
        return new Promise(resolve => {
            const req = https.get(url, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ success: false, error: `HTTP ${res.statusCode}` });
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve({ success: true, data: JSON.parse(data) }); } catch (e) { resolve({ success: false, error: "Malformed JSON" }); } });
            });
            req.on('error', (e) => resolve({ success: false, error: e.message }));
            req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
        });
    },

    log: (botId, message, type = "INFO") => {
        const timestamp = new Date().toLocaleTimeString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        const icons = { "INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "SUCCESS": "✅", "DEBUG": "🐛", "SLEEP": "💤", "PAUSE": "⏸️", "CIRCUIT": "🛡️" };
        console.log(`[${timestamp}] [Bot ${botId}] ${icons[type] || ""} ${message}`);
    }
};

// Helper for parseSelectors to avoid undefined error
function finalCleaned(t) { 
    const hasForce = /\bforce\b/i.test(t); 
    return hasForce ? t.replace(/\bforce\b/i, '').trim() : t; 
}

// ============================================================================
// 🧠 SERVIÇOS
// ============================================================================

class AIService {
    constructor() {
        this.client = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
        this.model = this.client ? this.client.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;
        this.cache = new Map(); 
    }

    async generateVariations(originalText, count = 5) {
        const heuristics = [originalText, originalText.replace(/[.!]/g, '...'), originalText.charAt(0).toLowerCase() + originalText.slice(1)];
        if (!this.model || originalText.length < 5) return heuristics;
        
        const cacheKey = crypto.createHash('md5').update(originalText).digest('hex');
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

        const prompt = `
        ROLE: Expert Paraphraser & Markdown Specialist.
        TASK: Generate ${count} variations of the input text.
        
        ⚠️ CRITICAL RULES (DO NOT BREAK):
        1. PRESERVE ALL MARKDOWN: Keep Headers (#), Bold (**), Lists (-/•), and Links ([x](y)) EXACTLY as they are structure-wise.
        2. PRESERVE LAYOUT: Do NOT remove line breaks or merge paragraphs.
        3. PRESERVE VARIABLES: Keep {name} placeholders intact.
        4. PRESERVE ALL EMOJIS: Keep ALL emojis (🎁, 🕐, 🔥, 💎) EXACTLY where they are. DO NOT remove or replace emojis.
        5. ONLY change synonyms and sentence structure of the plain text parts.
        
        OUTPUT: A valid JSON Array of strings.
        INPUT: """${originalText}"""
        `;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response.text();
            
            const cleanJson = response.replace(/```json/g, '').replace(/```/g, '').trim();
            const variations = JSON.parse(cleanJson);
            
            const flatVariations = Array.isArray(variations) 
                ? variations.map(v => Utils.sanitizeString(v)) 
                : [Utils.sanitizeString(variations)];
                
            const final = [...new Set([...flatVariations, originalText])];
            
            if (this.cache.size >= CONFIG.MAX_AI_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(cacheKey, final);
            return final;
        } catch (error) { 
            return heuristics; 
        }
    }
}

class RecoveryService {
    constructor() {
        this.emailReady = false;
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            this.transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
            this.emailReady = true;
        }
    }

    async sendBackup(botId, reason, state, client) {
        const safeState = JSON.stringify(state, (k, v) => v instanceof Set ? Array.from(v) : v, 2);
        const buffer = Buffer.from(safeState, 'utf-8');
        const filename = `backup_bot${botId}_${Date.now()}.json`;

        if (state.initiatorId && client) {
            try {
                const user = await client.users.fetch(state.initiatorId);
                const embed = new EmbedBuilder().setTitle(`🚨 EMERGENCY: Bot ${botId}`).setColor(0xFF0000).setDescription(`**Reason:** ${reason}`);
                await user.send({ embeds: [embed], files: [{ attachment: buffer, name: filename }] });
                return { success: true, method: 'DM' };
            } catch (e) {}
        }

        if (this.emailReady) {
            try {
                await this.transporter.sendMail({
                    from: process.env.EMAIL_USER, to: CONFIG.TARGET_EMAIL, subject: `🚨 STOP: Bot ${botId}`,
                    text: `Reason: ${reason}\nError: ${state.lastError}`, attachments: [{ filename: filename, content: safeState }]
                });
                return { success: true, method: 'EMAIL' };
            } catch (e) {}
        }
        return { success: false, method: 'CONSOLE' };
    }
}

// ============================================================================
// 💾 GERENCIADOR DE ESTADO
// ============================================================================

class StateManager {
    constructor(filePath, botId) {
        this.filePath = filePath;
        this.tempFilePath = `${filePath}.tmp`;
        this.botId = botId;
        this.saveTimer = null; 
        this.state = this.loadInitialState();
    }

    getDefaultState() {
        return {
            active: false, quarantine: false, lastError: null, text: "", variations: [], attachments: [], queue: [],
            ignore: new Set(), only: new Set(), currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null, currentAnnounceGuildId: null, privacyMode: 'public', initiatorId: null,
            activityLog: [], lastActivityTimestamp: Date.now(), circuitBreakerActiveUntil: null, guildData: {},
            nextSleepTrigger: null 
        };
    }

    loadInitialState() {
        try {
            if (!fs.existsSync(this.filePath)) return this.getDefaultState();
            const raw = fs.readFileSync(this.filePath, "utf8");
            const data = JSON.parse(raw);
            data.ignore = new Set(data.ignore || []); data.only = new Set(data.only || []);
            for (const gid in data.guildData) {
                const g = data.guildData[gid];
                g.processedMembers = new Set(g.processedMembers || []);
                g.blockedDMs = new Set(g.blockedDMs || []);
            }
            if (data.active && (!data.queue || data.queue.length === 0)) { 
                data.active = false; data.quarantine = false; data.circuitBreakerActiveUntil = null;
            }
            if (!data.nextSleepTrigger) data.nextSleepTrigger = Utils.getNextSleepTimestamp();
            return { ...this.getDefaultState(), ...data };
        } catch (error) { return this.getDefaultState(); }
    }

    saveImmediate() {
        const serializableState = { ...this.state, ignore: [...this.state.ignore], only: [...this.state.only], guildData: {} };
        for (const [gid, gdata] of Object.entries(this.state.guildData)) {
            serializableState.guildData[gid] = { ...gdata, processedMembers: [...gdata.processedMembers], blockedDMs: [...gdata.blockedDMs], failedQueue: gdata.failedQueue.slice(-CONFIG.MAX_STATE_HISTORY) };
        }
        const json = JSON.stringify(serializableState, null, 2);
        fs.writeFile(this.tempFilePath, json, (err) => {
            if (!err) fs.rename(this.tempFilePath, this.filePath, (e) => { if (e) Utils.log(this.botId, `Save Error: ${e.message}`, "ERROR"); });
        });
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveImmediate();
            this.saveTimer = null;
        }, CONFIG.STATE_SAVE_DEBOUNCE_MS);
    }

    async modify(callback) { await callback(this.state); this.scheduleSave(); }
    forceSave() { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveImmediate(); }
}

// ============================================================================
// 🧱 CLASSE MESTRA (STEALTHBOT)
// ============================================================================

class StealthBot {
    constructor(token, id) {
        this.token = token;
        this.id = id;
        this.stateManager = new StateManager(path.resolve(__dirname, `state_${id}.json`), id);
        const spoof = Utils.generateClientSpoof();
        
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds, 
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMembers, 
                GatewayIntentBits.GuildPresences, 
                GatewayIntentBits.DirectMessages, 
                GatewayIntentBits.MessageContent
            ],
            partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User, Partials.Reaction],
            ws: { version: 10, properties: spoof },
            rest: { timeout: 60000, retries: 3, offset: Math.floor(Math.random() * 2000) }
        });

        this.aiService = new AIService();
        this.recoveryService = new RecoveryService(); 
        this.sendsThisHour = 0;
        this.hourlyResetTime = Date.now() + 3600000;
        this.workerRunning = false;
        this.lastActivityTime = Date.now();
        this.lastPresenceActivity = ""; 
        this.logBuffer = this.stateManager.state.activityLog || []; 
        this.recentResults = [];
        this.lastEmbedRecovery = 0;
        this.wakingUpTime = null;
        this.forcedRun = false;
        this.memberCache = new Map(); 

        setInterval(() => this.runWatchdog(), 60000);
    }

    async getCachedMembers(guild) {
        const cached = this.memberCache.get(guild.id);
        if (cached && Date.now() - cached.timestamp < CONFIG.MEMBER_CACHE_TTL) return cached.members;
        
        Utils.log(this.id, `Fetching ALL members for ${guild.name}...`, "DEBUG");
        
        const members = new Map();
        let lastId = 0;
        
        try {
            while (true) {
                const fetched = await guild.members.fetch({ limit: 1000, after: lastId });
                if (fetched.size === 0) break;
                
                fetched.forEach((m) => members.set(m.id, m));
                lastId = fetched.last().id;
                
                Utils.log(this.id, `Fetched ${fetched.size} members... Total: ${members.size}`, "DEBUG");
                if (fetched.size < 1000) break;
                
                await new Promise(r => setTimeout(r, 500)); 
            }
        } catch (e) {
            Utils.log(this.id, `Fetch Error: ${e.message}. Using partial results.`, "WARN");
        }

        Utils.log(this.id, `Total Members Confirmed: ${members.size}`, "INFO");
        const membersArray = Array.from(members.values());
        this.memberCache.set(guild.id, { members: membersArray, timestamp: Date.now() });
        return membersArray;
    }

    async safeReply(ctx, content, options = {}) {
        const payload = typeof content === 'string' ? { content, ...options } : { ...content, ...options };
        if (ctx.isChatInputCommand && ctx.isChatInputCommand()) {
            if (ctx.deferred || ctx.replied) return await ctx.editReply(payload);
            return await ctx.reply(payload);
        }
        try { return await ctx.reply(payload); } catch (e) { Utils.log(this.id, `Reply Error: ${e.message}`, "WARN"); }
    }

    addActivityLog(message, type = 'INFO') {
        Utils.log(this.id, message, type);
        const timestamp = new Date().toLocaleTimeString('pt-BR', { timeZone: CONFIG.TIMEZONE, hour12: false });
        const icons = { "INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "SUCCESS": "✅", "PAUSE": "⏸️", "SLEEP": "💤", "CIRCUIT": "🛡️" };
        const logEntry = { time: timestamp, icon: icons[type] || "•", message: message.substring(0, 45) };
        this.logBuffer.unshift(logEntry);
        if (this.logBuffer.length > 5) this.logBuffer.pop();
        this.stateManager.modify(s => { s.activityLog = this.logBuffer; s.lastActivityTimestamp = Date.now(); });
    }

    detectSoftBan(stats) {
        const total = this.recentResults.length > 0 ? this.recentResults.length : (stats.success + stats.fail + stats.closed);
        if (total < CONFIG.THRESHOLDS.SOFT_BAN_MIN_SAMPLES) return false;
        const failures = this.recentResults.length > 0 
            ? this.recentResults.filter(r => r === 'fail' || r === 'closed').length 
            : stats.fail + stats.closed;
        return (failures / total) >= CONFIG.THRESHOLDS.SOFT_BAN_THRESHOLD;
    }

    addResult(type) {
        this.recentResults.push(type);
        if (this.recentResults.length > 50) this.recentResults.shift();
    }

    analyzeRejectionRate() {
        if (this.recentResults.length < 20) return 0;
        const closed = this.recentResults.filter(r => r === 'closed').length;
        return closed / this.recentResults.length;
    }

    getBotStatus() {
        const s = this.stateManager.state;
        if (s.quarantine) return { emoji: "🚨", text: "Quarantined" };
        if (s.circuitBreakerActiveUntil && Date.now() < s.circuitBreakerActiveUntil) {
            const minLeft = Math.ceil((s.circuitBreakerActiveUntil - Date.now()) / 60000);
            return { emoji: "🛡️", text: `Cooling (${minLeft}m)` };
        }
        
        if (this.wakingUpTime && Date.now() < this.wakingUpTime) {
             const minsLeft = Math.ceil((this.wakingUpTime - Date.now()) / 60000);
             return { emoji: "💤", text: `Sleeping (${Math.floor(minsLeft/60)}h ${minsLeft%60}m)` };
        }

        if (!s.active && s.queue.length > 0) return { emoji: "⏸️", text: "Paused" };
        if (!s.active) return { emoji: "⚪", text: "Idle" };
        return { emoji: "🟢", text: "Active" };
    }

    runWatchdog() {
        const wsStatus = this.client.ws.status; 
        const isFrozen = this.stateManager.state.active && (Date.now() - this.lastActivityTime > CONFIG.INACTIVITY_THRESHOLD);
        if (wsStatus !== 0) {
             this.addActivityLog(`WS (${wsStatus}). Reconnecting.`, "WARN");
             this.client.destroy();
             this.client.login(this.token);
        } else if (isFrozen) {
            if (this.wakingUpTime && Date.now() < this.wakingUpTime) return; 
            this.addActivityLog("Freeze Detected. Restarting.", "WARN");
            this.startWorker(true);
        }
    }

    async waitExponential(retryCount) {
        const base = 5000;
        const delay = Math.min(base * Math.pow(2, retryCount), 60000); 
        await this.wait(delay);
    }

    async wait(ms) {
        this.lastActivityTime = Date.now();
        if (ms < 1000) return;
        
        if (ms > 120000) { 
            const minutes = Math.floor(ms / 60000);
            if (ms < CONFIG.SLEEP_MIN_DURATION) this.addActivityLog(`Wait: ${minutes}m...`, "INFO");
            
            const chunks = Math.ceil(ms / 60000);
            for (let i = 0; i < chunks; i++) {
                if (!this.stateManager.state.active || this.stateManager.state.quarantine) return;
                await new Promise(r => setTimeout(r, 60000));
                this.lastActivityTime = Date.now(); 
                if (i % 5 === 0) await this.updateEmbed();
            }
        } else {
            await new Promise(r => setTimeout(r, ms));
        }
    }

    checkHourlyLimit() {
        const now = Date.now();
        if (now > this.hourlyResetTime) { this.sendsThisHour = 0; this.hourlyResetTime = now + 3600000; }
        return this.sendsThisHour >= CONFIG.MAX_SENDS_PER_HOUR ? { exceeded: true, waitTime: this.hourlyResetTime - now } : { exceeded: false };
    }

    calculateTypingTime(textLength) {
        const wpm = CONFIG.WPM_MEAN + (Math.random() * CONFIG.WPM_DEV * (Math.random() > 0.5 ? 1 : -1));
        const cps = (wpm * 5) / 60; 
        let duration = (textLength / cps) * 1000;
        duration += 800 + Math.random() * 1500;
        return Math.min(duration, 15000);
    }

    async ensureGuildData(guildId) {
        const s = this.stateManager.state;
        if (!s.guildData[guildId]) s.guildData[guildId] = { processedMembers: new Set(), blockedDMs: new Set(), failedQueue: [], pendingQueue: [] };
        return s.guildData[guildId];
    }

    async sendStealthDM(user, rawText, attachments, variations) {
        Utils.log(this.id, `Attempting DM to ${user.tag}`, "DEBUG"); 
        this.lastActivityTime = Date.now();
        
        try {
            let dmChannel;
            try { dmChannel = user.dmChannel || await user.createDM(); } catch (e) { 
                Utils.log(this.id, `Failed to open DM: ${user.tag} - ${e.message}`, "WARN");
                return { success: false, reason: "closed" }; 
            }

            // V31.0: Robust selection & sanitization
            const textTemplate = (variations?.length > 0) 
                ? variations[Math.floor(Math.random() * variations.length)] 
                : rawText;
            
            const cleanTemplate = Utils.sanitizeString(textTemplate);
            const finalText = Utils.personalizeText(cleanTemplate, user);
            
            if (!finalText && (!attachments || attachments.length === 0)) return { success: false, reason: "empty" };

            const shouldType = Math.random() < 0.80; 
            if (shouldType && finalText) {
                const typeTime = this.calculateTypingTime(finalText.length);
                try { await dmChannel.sendTyping(); await this.wait(typeTime); } catch(e) {}
            } else { await this.wait(1500 + Math.random() * 2000); }

            const payload = {};
            if (finalText) payload.content = finalText;
            if (attachments?.length) payload.files = attachments;

            for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
                try {
                    await dmChannel.send(payload);
                    this.addActivityLog(`Sent: ${user.tag}`, "SUCCESS");
                    return { success: true };
                } catch (err) {
                    const code = err.code || 0;
                    if (code === 40003 || err.message.toLowerCase().includes("spam")) {
                        await this.stateManager.modify(s => { s.quarantine = true; s.lastError = `API ${code}: ${err.message}`; });
                        return { success: false, reason: "quarantine" };
                    }
                    if (code === 50007 || code === 20016 || code === 50001) return { success: false, reason: "closed" };
                    
                    if (err.retry_after) { 
                        await this.wait(err.retry_after * 1000 + 1000); 
                        continue; 
                    }
                    
                    if (code >= 500) {
                        await this.waitExponential(attempt);
                        if (attempt === CONFIG.MAX_RETRIES - 1) return { success: false, reason: "network" };
                    }
                }
            }
            return { success: false, reason: "fail" };
        } catch (globalErr) {
            Utils.log(this.id, `CRITICAL FAIL on ${user.tag}: ${globalErr.message}`, "ERROR");
            return { success: false, reason: "fail" };
        }
    }

    async workerLoop() {
        this.addActivityLog("Worker Started", "INFO");
        const circuit = { closed: 0, network: 0, successStreak: 0 };
        
        try {
            while (this.stateManager.state.active && this.stateManager.state.queue.length > 0) {
                const state = this.stateManager.state;
                
                if (!this.forcedRun && Utils.isSleepTime()) {
                     this.addActivityLog("Sleep Mode Active. Stopping.", "SLEEP");
                     const msUntilWake = Utils.getWakeTime();
                     this.wakingUpTime = Date.now() + msUntilWake;
                     await this.stateManager.modify(s => s.active = false); 
                     
                     setTimeout(() => {
                         this.wakingUpTime = null;
                         if (state.queue.length > 0) {
                             this.addActivityLog("Waking Up! Resuming...", "INFO");
                             this.stateManager.modify(s => s.active = true);
                             this.startWorker();
                         }
                     }, msUntilWake);
                     
                     break; 
                }

                if (state.circuitBreakerActiveUntil && Date.now() < state.circuitBreakerActiveUntil) {
                    const waitMs = state.circuitBreakerActiveUntil - Date.now();
                    this.addActivityLog(`Cooling: ${Math.ceil(waitMs/60000)}m left`, "CIRCUIT");
                    await this.wait(waitMs);
                    await this.stateManager.modify(s => s.circuitBreakerActiveUntil = null);
                }

                const batchSize = Math.floor(Math.random() * (CONFIG.BATCH_SIZE_MAX - CONFIG.BATCH_SIZE_MIN + 1)) + CONFIG.BATCH_SIZE_MIN;
                const guild = this.client.guilds.cache.get(state.currentAnnounceGuildId);

                for (let i = 0; i < batchSize; i++) {
                    if (!state.active || state.queue.length === 0 || state.quarantine) break;
                    if (state.circuitBreakerActiveUntil) break;
                    
                    if (!this.forcedRun && Utils.isSleepTime()) break;

                    const limitCheck = this.checkHourlyLimit();
                    if (limitCheck.exceeded) await this.wait(limitCheck.waitTime + 10000);

                    const userId = state.queue.shift();
                    await this.stateManager.modify(() => {}); 

                    if (guild) {
                        try { await guild.members.fetch(userId); } catch (e) {
                            Utils.log(this.id, `User ${userId} left. Skipping.`, "DEBUG");
                            await this.stateManager.modify(s => { s.guildData[s.currentAnnounceGuildId].processedMembers.add(userId); });
                            continue; 
                        }
                    }

                    let user;
                    try { user = await this.client.users.fetch(userId); } catch (e) { continue; }
                    const gd = await this.ensureGuildData(state.currentAnnounceGuildId);

                    // V31.0: Check Filters
                    const accountStatus = Utils.checkAccountStatus(user);
                    if (user.bot || gd.blockedDMs.has(userId) || !accountStatus.safe) continue;

                    const result = await this.sendStealthDM(user, state.text, state.attachments, state.variations);
                    this.sendsThisHour++;

                    if (result.success) this.addResult('success');
                    else if (result.reason === 'closed') this.addResult('closed');
                    else this.addResult('fail');

                    await this.stateManager.modify(s => {
                        const g = s.guildData[s.currentAnnounceGuildId];
                        if (result.success) {
                            s.currentRunStats.success++;
                            circuit.successStreak++;
                            if (circuit.successStreak >= CONFIG.THRESHOLDS.REQUIRED_SUCCESS_TO_RESET) { circuit.closed = 0; circuit.network = 0; }
                            g.processedMembers.add(userId);
                            this.engageContextually(state.currentAnnounceGuildId);
                        } else if (result.reason === 'closed') {
                            s.currentRunStats.closed++;
                            circuit.closed++;
                            circuit.successStreak = 0;
                            g.blockedDMs.add(userId);
                        } else if (result.reason === 'network' || result.reason === 'fail') {
                            s.currentRunStats.fail++;
                            circuit.network++;
                            circuit.successStreak = 0;
                            g.failedQueue.push(userId);
                        }
                    });

                    if (this.detectSoftBan(state.currentRunStats)) {
                        this.addActivityLog("Soft-Ban. Pausing.", "ERROR");
                        await this.stateManager.modify(s => { s.quarantine = true; s.active = false; });
                        await this.recoveryService.sendBackup(this.id, "SOFT-BAN", state, this.client);
                        break;
                    }

                    if (state.quarantine) {
                        const res = await this.recoveryService.sendBackup(this.id, "QUARANTINE", state, this.client);
                        this.addActivityLog(`Backup sent: ${res.method}`, "WARN");
                        break;
                    }

                    if (circuit.closed >= CONFIG.THRESHOLDS.CONSECUTIVE_CLOSED_DMS) {
                        await this.stateManager.modify(s => s.circuitBreakerActiveUntil = Date.now() + CONFIG.CLOSED_DM_COOLING_MS);
                        this.addActivityLog(`Privacy Cooling.`, "CIRCUIT");
                        await this.updateEmbed();
                        circuit.closed = 0;
                        break; 
                    }
                    
                    if (circuit.network >= CONFIG.THRESHOLDS.CONSECUTIVE_NET_ERRORS) {
                        this.addActivityLog("Network Cooling (1m)", "CIRCUIT");
                        await this.wait(60000);
                        circuit.network = 0;
                    }

                    const delay = Utils.calculateHumanDelay();
                    await this.updateEmbed();
                    
                    if (Math.random() < 0.15) {
                        this.addActivityLog("Coffee Break ☕", "INFO");
                        await this.wait(25000 + Math.random() * 35000);
                    } else {
                        await this.wait(delay);
                    }
                }

                if (state.quarantine) break;

                if (state.active && state.queue.length > 0 && !state.circuitBreakerActiveUntil && Date.now() < state.nextSleepTrigger) {
                    const rate = this.analyzeRejectionRate();
                    let range = CONFIG.PAUSE_NORMAL;
                    if (rate > CONFIG.THRESHOLDS.CRITICAL_REJECTION_RATE) range = CONFIG.PAUSE_CRITICAL;
                    else if (rate > 0.3) range = CONFIG.PAUSE_CAUTION;

                    const pause = Math.floor(Math.random() * (range.MAX - range.MIN + 1)) + range.MIN;
                    this.addActivityLog(`Batch Pause: ${pause}m`, "PAUSE");
                    await this.wait(pause * 60 * 1000);
                    
                    this.forcedRun = false; 
                }
            }
        } catch (error) {
            this.addActivityLog(`CRASH: ${error.message}`, "ERROR");
            await this.stateManager.modify(s => s.lastError = `Crash: ${error.message}`);
            const res = await this.recoveryService.sendBackup(this.id, "CRASH", this.stateManager.state, this.client);
            this.addActivityLog(`Backup sent: ${res.method}`, "WARN");
        } finally {
            this.workerRunning = false;
            await this.finalizeWorker();
        }
    }

    async engageContextually(guildId) {
        if (!guildId || Math.random() > 0.15) return;
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return;
            const channel = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(this.client.user)?.has(PermissionsBitField.Flags.ViewChannel)).random();
            if (!channel) return;
            const msgs = await channel.messages.fetch({ limit: 5 });
            const target = msgs.filter(m => !m.author.bot).random();
            if (target) {
                if (Math.random() < 0.05) await target.reply(["👀", "nice", "top", "brabo", "🔥"][Math.floor(Math.random() * 5)]);
                else await target.react(["👍", "🔥", "👀"][Math.floor(Math.random() * 3)]);
            }
        } catch (e) {}
    }

    async finalizeWorker() {
        const s = this.stateManager.state;
        if (s.queue.length === 0 && !s.quarantine) {
            await this.stateManager.modify(st => {
                const g = st.guildData[st.currentAnnounceGuildId];
                if(g) g.pendingQueue = []; 
            });
            this.addActivityLog("Finalizing...", "INFO"); 
        } else if (s.queue.length > 0 && s.currentAnnounceGuildId) {
            await this.stateManager.modify(st => {
                const g = st.guildData[st.currentAnnounceGuildId];
                if (g) g.pendingQueue.push(...st.queue);
                st.queue = [];
            });
        }
        
        if (!s.quarantine) await this.stateManager.modify(st => st.active = false);
        await this.wait(2000);
        await this.updateEmbed();
        this.addActivityLog("Campaign Finished", "SUCCESS");
        this.stateManager.forceSave();
    }

    async updateEmbed() {
        const s = this.stateManager.state;
        if (!s.progressMessageRef) return;
        try {
            const ch = await this.client.channels.fetch(s.progressMessageRef.channelId);
            const msg = await ch.messages.fetch(s.progressMessageRef.messageId);
            const status = this.getBotStatus();
            const stats = s.currentRunStats;
            const logs = this.logBuffer.slice(0, 5).map(l => `${l.time} ${l.icon} ${l.message}`).join('\n') || 'Starting...';
            const timeSince = Math.floor((Date.now() - s.lastActivityTimestamp) / 1000);
            const timeText = timeSince < 60 ? `${timeSince}s ago` : `${Math.floor(timeSince/60)}m ago`;

            const embed = new EmbedBuilder()
                .setTitle(`${status.emoji} Bot ${this.id} | V31.0 ULTIMATE`)
                .setDescription(`**Status:** ${status.text}`)
                .setColor(s.quarantine ? 0xFF0000 : status.text === 'Active' ? 0x00FF00 : 0xFFAA00)
                .addFields(
                    { name: "📊 Stats", value: `✅ ${stats.success} | 🚫 ${stats.closed} | ❌ ${stats.fail} | ⏳ ${s.queue.length}`, inline: false },
                    { name: "🔍 Activity Log", value: `\`\`\`${logs}\`\`\``, inline: false },
                    { name: "⏱️ Last Activity", value: timeText, inline: true }
                ).setTimestamp();
            if (s.quarantine) embed.addFields({ name: "🚨 Error", value: s.lastError || "?" });
            await msg.edit({ embeds: [embed] });
        } catch (e) {}
    }

    startWorker(force = false) {
        if (this.workerRunning) return;
        
        if (!force && Utils.isSleepTime()) {
            this.addActivityLog("Sleep Mode. Worker delayed until 8 AM.", "SLEEP");
            const msUntilWake = Utils.getWakeTime();
            this.wakingUpTime = Date.now() + msUntilWake;
            
            setTimeout(() => {
                this.wakingUpTime = null;
                if (this.stateManager.state.active) {
                    this.addActivityLog("Waking Up!", "INFO");
                    this.startWorker();
                }
            }, msUntilWake);
            return;
        }

        this.forcedRun = force;
        this.workerRunning = true;
        this.workerLoop();
    }

    async start() {
        this.client.on(Events.ClientReady, async () => {
            Utils.log(this.id, `Online: ${this.client.user.tag}`, "SUCCESS");
            this.startPresenceLoop();
            
            this.client.on('interactionCreate', i => this.handleInteraction(i));
            this.client.on('messageCreate', m => this.handleMessage(m));

            const cmds = [
                new SlashCommandBuilder().setName('announce').setDescription('Start').addStringOption(o=>o.setName('text').setDescription('Msg').setRequired(true)).addAttachmentOption(o=>o.setName('file').setDescription('Img')).addStringOption(o=>o.setName('filter').setDescription('Filter')),
                new SlashCommandBuilder().setName('update').setDescription('Add'),
                new SlashCommandBuilder().setName('resume').setDescription('Resume').addAttachmentOption(o=>o.setName('file').setDescription('JSON')),
                new SlashCommandBuilder().setName('stop').setDescription('Stop'),
                new SlashCommandBuilder().setName('status').setDescription('Stats'),
                new SlashCommandBuilder().setName('reset').setDescription('Reset'),
                new SlashCommandBuilder().setName('lastbackup').setDescription('Recovers last state') 
            ];
            try { await new REST({version:'10'}).setToken(this.token).put(Routes.applicationCommands(this.client.user.id), {body:cmds}); } catch(e){}

            if (this.stateManager.state.active) this.startWorker();
        });
        await this.client.login(this.token);
    }

    // --- HANDLERS ---

    async handleInteraction(i) {
        if (!i.isChatInputCommand() || !i.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        
        try {
            if (i.commandName === 'announce') {
                if (this.stateManager.state.active) return this.safeReply(i, "❌ Busy. /stop first.");
                const text = i.options.getString('text');
                const attach = i.options.getAttachment('file')?.url;
                const filter = i.options.getString('filter');
                await this.execAnnounce(i, text, attach, filter);
            } else if (i.commandName === 'resume') {
                const file = i.options.getAttachment('file')?.url;
                await this.execResume(i, file);
            } else if (i.commandName === 'stop') await this.execStop(i);
            else if (i.commandName === 'status') await this.execStatus(i);
            else if (i.commandName === 'reset') await this.execReset(i);
            else if (i.commandName === 'update') await this.execUpdate(i);
            else if (i.commandName === 'lastbackup') await this.execLastBackup(i);
        } catch (e) {
            console.error(`Cmd Error: ${e.message}`);
            this.safeReply(i, `❌ Error: ${e.message}`);
        }
    }

    async handleMessage(m) {
        if (m.author.bot) return;
        if (!m.guild) return;
        if (!m.content) return;
        if (!m.content.startsWith('!')) return;
        
        let member = m.member;
        if (!member) { 
            try { member = await m.guild.members.fetch(m.author.id); } 
            catch(e) { Utils.log(this.id, `Fetch failed: ${e.message}`, "WARN"); return; } 
        }
        
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const args = m.content.slice(1).trim().split(/ +/);
        const cmd = args.shift().toLowerCase();
        
        try {
            if (cmd === 'announce') {
                if (this.stateManager.state.active) return this.safeReply(m, "❌ Busy. !stop first.");
                const fullContent = m.content.slice(9).trim(); 
                const attach = m.attachments.first()?.url;
                await this.execAnnounce(m, fullContent, attach, fullContent);
            } 
            else if (cmd === 'resume') {
                 const attachment = m.attachments.first();
                 await this.execResume(m, attachment ? attachment.url : null);
            }
            else if (cmd === 'stop') await this.execStop(m);
            else if (cmd === 'status') await this.execStatus(m);
            else if (cmd === 'reset') await this.execReset(m);
            else if (cmd === 'update') await this.execUpdate(m);
            else if (cmd === 'lastbackup') await this.execLastBackup(m);
        } catch (e) { 
            console.error(`Msg Error: ${e.message}`); 
            this.safeReply(m, `❌ Error: ${e.message}`);
        }
    }

    async execAnnounce(ctx, text, attachmentUrl, filtersStr) {
        const isSlash = !!ctx.isChatInputCommand;
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;

        // V24.0 INSTANT FEEDBACK
        let statusMsg;
        if (isSlash) {
            statusMsg = await ctx.editReply("⏳ Loading Members & AI...");
        } else {
            statusMsg = await ctx.reply("⏳ Loading Members & AI...");
        }

        // Logic continues in background...
        const parsed = Utils.parseSelectors(filtersStr || "");
        
        // 🔥 V31.0: Apply parser BEFORE anything else
        let messageText = isSlash ? Utils.parseSlashInput(text) : parsed.cleaned; 

        const attachments = (attachmentUrl && Utils.isValidUrl(attachmentUrl)) ? [attachmentUrl] : [];
        if (!messageText && attachments.length === 0) {
            if(isSlash) return ctx.editReply("❌ Empty Message.");
            return statusMsg.edit("❌ Empty Message.");
        }

        const gd = await this.ensureGuildData(ctx.guild.id);
        const vars = await this.aiService.generateVariations(messageText);
        
        const members = await this.getCachedMembers(ctx.guild);
        
        const queue = [];
        for (const m of members) {
             if (m.user.bot) continue;
             if (parsed.ignore.has(m.id) || gd.blockedDMs.has(m.id)) continue;
             if (parsed.only.size > 0 && !parsed.only.has(m.id)) continue;
             
             const acctStatus = Utils.checkAccountStatus(m.user);
             if (!acctStatus.safe) continue;
             
             queue.push(m.id);
        }
        
        // V28.1: Allow self-DM for test
        const finalQueue = queue;

        if (!parsed.hasForce && (gd.pendingQueue.length || gd.failedQueue.length)) {
            const msg = "⚠️ Queue pending. Use `force`.";
            if(isSlash) return ctx.editReply(msg);
            return statusMsg.edit(msg);
        }
        if (!finalQueue.length) {
            const msg = "❌ No targets (Filters active). Check logs.";
            if(isSlash) return ctx.editReply(msg);
            return statusMsg.edit(msg);
        }

        const nextSleep = Utils.getNextSleepTimestamp();

        await this.stateManager.modify(s => {
            s.active = true; s.quarantine = false; s.text = messageText; s.variations = vars; s.attachments = attachments; s.queue = finalQueue; s.currentAnnounceGuildId = ctx.guild.id; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.privacyMode = isSlash ? 'private' : 'public'; s.initiatorId = initiatorId; s.activityLog = []; s.lastActivityTimestamp = Date.now();
            s.nextSleepTrigger = nextSleep; 
            if (parsed.hasForce) { s.guildData[ctx.guild.id].pendingQueue = []; s.guildData[ctx.guild.id].failedQueue = []; }
        });

        const initialEmbed = new EmbedBuilder()
            .setTitle(`🚀 Initializing Bot ${this.id}...`)
            .setDescription("Preparing queue and starting worker...")
            .setColor(0x00AEEF)
            .addFields({ name: "📊 Stats", value: `⏳ Queue: ${finalQueue.length}`, inline: false });

        let panelMsg;
        if (isSlash) {
            panelMsg = await ctx.editReply({ content: "", embeds: [initialEmbed] });
            await this.safeReply(ctx, "✅ Panel in DM."); 
        } else {
            panelMsg = await statusMsg.edit({ content: "", embeds: [initialEmbed] });
        }

        await this.stateManager.modify(s => s.progressMessageRef = { channelId: panelMsg.channel.id, messageId: panelMsg.id });
        this.startWorker(true);
    }

    async execStop(ctx) {
        await this.stateManager.modify(s => s.active = false);
        await this.safeReply(ctx, "🛑 Stopped.");
    }

    async execStatus(ctx) {
        const s = this.stateManager.state;
        const embed = new EmbedBuilder().setTitle("Status").setDescription(`Active: ${s.active}\nQueue: ${s.queue.length}\nQuarantine: ${s.quarantine}`);
        await this.safeReply(ctx, { embeds: [embed] });
    }

    async execUpdate(ctx) {
        const gd = await this.ensureGuildData(ctx.guild.id);
        try { await ctx.guild.members.fetch(); } catch(e){}
        const known = new Set([...gd.processedMembers, ...gd.blockedDMs, ...gd.failedQueue, ...gd.pendingQueue, ...this.stateManager.state.queue]);
        const newMems = ctx.guild.members.cache.filter(m => !m.user.bot && !known.has(m.id) && !Utils.isSuspiciousAccount(m.user)).map(m => m.id);
        if (!newMems.length) return this.safeReply(ctx, "✅ Nothing new.");
        await this.stateManager.modify(st => st.queue.push(...newMems));
        await this.safeReply(ctx, `🔄 Added +${newMems.length}.`);
    }

    async execReset(ctx) {
        await this.stateManager.modify(s => { s.active = false; s.quarantine = false; s.queue = []; s.lastError = null; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.activityLog = []; s.circuitBreakerActiveUntil = null; });
        await this.safeReply(ctx, "☢️ Reset.");
    }

    async execResume(ctx, attachmentUrl) {
        if (this.stateManager.state.active) return this.safeReply(ctx, "⚠️ Active.");
        let backup = null;
        if (attachmentUrl) { const res = await Utils.fetchJsonFromUrl(attachmentUrl); if (res.success) backup = res.data; }
        
        const gd = await this.ensureGuildData(ctx.guild.id);
        let q = [...new Set([...this.stateManager.state.queue, ...gd.pendingQueue, ...gd.failedQueue, ...(backup?.queue || [])])].filter(id => !gd.blockedDMs.has(id));
        if (!q.length) return this.safeReply(ctx, "✅ Empty.");
        
        const nextSleep = Utils.getNextSleepTimestamp();

        await this.stateManager.modify(s => {
            s.active = true; s.quarantine = false; s.queue = q; s.currentAnnounceGuildId = ctx.guild.id; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.guildData[ctx.guild.id].pendingQueue = []; s.initiatorId = ctx.user?.id || ctx.author.id; 
            s.nextSleepTrigger = nextSleep; 
            if (backup) { if(backup.text) s.text = backup.text; if(backup.variations) s.variations = backup.variations; if(backup.attachments) s.attachments = backup.attachments; }
        });
        
        const initialEmbed = new EmbedBuilder()
            .setTitle(`🔄 Resuming Bot ${this.id}...`)
            .setDescription("Recovering state and starting worker...")
            .setColor(0x00AEEF)
            .addFields({ name: "📊 Stats", value: `⏳ Queue: ${q.length}`, inline: false });

        let msg;
        if (ctx.isChatInputCommand) {
             const dm = await ctx.user.createDM();
             msg = await dm.send({ embeds: [initialEmbed] });
             await this.safeReply(ctx, "✅ Painel na DM.");
        } else {
             msg = await ctx.reply({ embeds: [initialEmbed] });
        }
        await this.stateManager.modify(s => s.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id });
        
        this.startWorker(true);
    }

    async execLastBackup(ctx) {
        const isSlash = !!ctx.isChatInputCommand;
        const reply = async (msg) => {
            if (isSlash) return (ctx.deferred || ctx.replied) ? ctx.editReply(msg) : ctx.reply(msg);
            return ctx.reply(msg);
        };

        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;
        const s = this.stateManager.state;
        const gd = s.guildData[ctx.guild.id];
        
        if (!gd || (!gd.pendingQueue.length && !gd.failedQueue.length)) return reply("✅ No data.");
        
        const totalQueue = s.queue.length + (gd ? (gd.pendingQueue.length + gd.failedQueue.length) : 0);
        const lastActivity = new Date(s.lastActivityTimestamp).toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });

        const embed = new EmbedBuilder()
            .setTitle("💾 Backup Available")
            .setColor(0x00AEEF)
            .setDescription(`**Timestamp:** ${lastActivity}\n**Pending Users:** ${totalQueue}`)
            .setFooter({ text: "Recover this state?" });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('backup_yes').setLabel('✅ Yes').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('backup_no').setLabel('❌ No').setStyle(ButtonStyle.Secondary)
        );
        
        const msg = await reply({ embeds: [embed], components: [row], fetchReply: true });
        const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        
        collector.on('collect', async i => {
            if (i.user.id !== initiatorId) return i.reply({ content: "⛔ Denied.", flags: MessageFlags.Ephemeral });
            
            if (i.customId === 'backup_yes') {
                const buffer = Buffer.from(JSON.stringify(s, null, 2), 'utf-8');
                const filename = `backup_guild${ctx.guild.id}_${Date.now()}.json`;
                await i.update({ content: "📤 Sending...", embeds: [], components: [] });
                try {
                    await i.user.send({ content: "💾 **Backup File**", files: [{ attachment: buffer, name: filename }] });
                    if (!isSlash) await ctx.reply("✅ Backup sent to DM."); 
                    else await i.followUp({ content: "✅ Backup sent to DM.", flags: MessageFlags.Ephemeral });
                } catch (e) {
                    if (!isSlash) await ctx.reply("❌ Check DM privacy."); 
                    else await i.followUp({ content: "❌ Check DM privacy.", flags: MessageFlags.Ephemeral });
                }
            } else { 
                await i.update({ content: "❌ Cancelled.", embeds: [], components: [] }); 
            }
            collector.stop();
        });
    }

    startPresenceLoop() {
        const next = () => {
            const activities = [{name:"VS Code",type:0},{name:"Spotify",type:2},{name:"YouTube",type:3}];
            const act = activities[Math.floor(Math.random()*activities.length)];
            if (act.name !== this.lastPresenceActivity) {
                this.client.user.setPresence({activities:[act],status:'online'});
                this.lastPresenceActivity = act.name;
            }
            const meanTime = (20 + Math.random() * 20) * 60 * 1000;
            setTimeout(next, Utils.getPoissonInterval(meanTime));
        };
        next();
    }
}

// ============================================================================
// 🚀 BOOTSTRAPPER & HTTP SERVER
// ============================================================================
const bots = [];
let i = 1;
while(true) {
    const t = process.env[i===1?'DISCORD_TOKEN':`DISCORD_TOKEN${i}`];
    if(!t) break;
    const b = new StealthBot(t, i++);
    b.start();
    bots.push(b);
}

http.createServer((req, res) => {
    const uptime = process.uptime();
    const status = {
        status: "V31.0 ULTIMATE FORMAT ONLINE",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        timestamp: new Date().toISOString(),
        bots: bots.map(b => ({ 
            id: b.id, 
            q: b.stateManager.state.queue.length, 
            active: b.stateManager.state.active 
        }))
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
}).listen(CONFIG.HTTP_PORT, () => {
    console.log(`🛡️ V31.0 ONLINE | PORT ${CONFIG.HTTP_PORT}`);
});

process.on('SIGTERM', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });