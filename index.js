/**
 * ============================================================================
 * PROJECT: DISCORD MASS DM BOT - V9.6 APEX REFINED
 * ARCHITECTURE: Event-Driven | Box-Muller Math | O(1) State | Adapter Pattern
 * ENGINE: Node.js + Discord.js v14
 * AUTHOR: Matheus Schumacher & Gemini Engineering Team
 * DATE: December 2025
 * * [CHANGELOG V9.6]
 * 1. CLEANUP: Fixed cosmetic destructuring bug in announce command.
 * 2. CERTIFIED: Full entropy, atomic persistence, and circuit breakers active.
 * 3. STABLE: No functional changes to logic, just polish.
 * ============================================================================
 */

require("dotenv").config();

// ============================================================================
// 📦 CORE MODULES
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
// ⚙️ 1. CENTRAL CONFIGURATION
// ============================================================================

const CONFIG = {
    // --- Identity & Infrastructure ---
    TARGET_EMAIL: process.env.TARGET_EMAIL || "admin@example.com",
    CONTROL_CHANNEL_ID: process.env.CONTROL_CHANNEL_ID,
    TIMEZONE: process.env.TZ || "America/Sao_Paulo",
    IS_CLOUD: !!(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.PORT),
    
    // --- Security & Circuit Breakers ---
    THRESHOLDS: {
        CONSECUTIVE_CLOSED_DMS: 5,     
        CONSECUTIVE_NET_ERRORS: 5,     
        REQUIRED_SUCCESS_TO_RESET: 3,  
        CRITICAL_REJECTION_RATE: 0.4,  
    },
    
    // --- Timings & Cooling (ms) ---
    CLOSED_DM_COOLING_MS: 5 * 60 * 1000, 
    MAX_SENDS_PER_HOUR: 95,            
    INACTIVITY_THRESHOLD: 120 * 1000,  
    STATE_SAVE_DEBOUNCE_MS: 5000,      
    
    // --- Filters ---
    MIN_ACCOUNT_AGE_DAYS: 30,
    IGNORE_NO_AVATAR: true,
    MAX_RETRIES: 3,
    
    // --- Humanization ---
    PEAK_HOUR_START: 18,
    PEAK_HOUR_END: 23,
    BATCH_SIZE_MIN: 6,
    BATCH_SIZE_MAX: 10,
    WPM_MEAN: 55, 
    WPM_DEV: 15,
    
    // --- Memory ---
    MAX_STATE_HISTORY: 1000,
    MAX_AI_CACHE_SIZE: 1000, 
    
    // --- Pauses (Minutes) ---
    PAUSE_NORMAL: { MIN: 3, MAX: 8 },
    PAUSE_CAUTION: { MIN: 8, MAX: 15 },
    PAUSE_CRITICAL: { MIN: 15, MAX: 30 }
};

// ============================================================================
// 🛠️ 2. UTILITIES & MATH ENGINE
// ============================================================================

const Utils = {
    isPeakHour: () => {
        const date = new Date();
        const hourStr = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: CONFIG.TIMEZONE
        }).format(date);
        const hour = parseInt(hourStr, 10);
        return hour >= CONFIG.PEAK_HOUR_START && hour <= CONFIG.PEAK_HOUR_END;
    },

    calculateHumanDelay: () => {
        let u = 0, v = 0;
        while(u === 0) u = Math.random();
        while(v === 0) v = Math.random();
        
        const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        const mu = 3.6;
        const sigma = 0.6;
        
        let delay = Math.exp(mu + sigma * z) * 1000;

        if (Utils.isPeakHour()) {
            delay *= (1.2 + Math.random() * 0.5);
        }

        return Math.floor(Math.max(12000, delay));
    },

    isValidUrl: (string) => {
        if (!string) return false;
        try {
            const url = new URL(string);
            return url.protocol === "http:" || url.protocol === "https:";
        } catch (_) {
            return false;
        }
    },

    getPoissonInterval: (meanTimeMs) => {
        const lambda = 1 / meanTimeMs;
        return -Math.log(1 - Math.random()) / lambda;
    },

    generateClientSpoof: () => {
        const osList = ["Windows", "macOS", "Linux"];
        const browsers = ["Discord Client", "Chrome", "Firefox", "Edge"];
        const releases = ["stable", "canary", "ptb"];
        return {
            os: osList[Math.floor(Math.random() * osList.length)],
            browser: browsers[Math.floor(Math.random() * browsers.length)],
            release_channel: releases[Math.floor(Math.random() * releases.length)],
            client_version: "1.0." + (9000 + Math.floor(Math.random() * 1000)),
            os_version: (10 + Math.random() * 5).toFixed(1),
            device: Math.random() > 0.6 ? "Desktop" : "",
            system_locale: Math.random() > 0.5 ? "pt-BR" : "en-US",
            client_build_number: 100000 + Math.floor(Math.random() * 50000)
        };
    },

    personalizeText: (template, user) => {
        if (!template) return "";
        const displayName = user.globalName || user.username || "amigo";
        const safeName = displayName.replace(/[*_`~|@]/g, '');
        return template.replace(/\{name\}|\{username\}|\{nome\}/gi, safeName);
    },

    isSuspiciousAccount: (user) => {
        const ageInDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
        const noAvatar = CONFIG.IGNORE_NO_AVATAR && !user.avatar;
        const tooNew = ageInDays < CONFIG.MIN_ACCOUNT_AGE_DAYS;
        return noAvatar || tooNew;
    },

    parseFilters: (text) => {
        const ignore = new Set();
        const only = new Set();
        const regex = /([+-])\{(\d{17,20})\}/g;
        let match;
        while ((match = regex.exec(text))) {
            if (match[1] === '-') ignore.add(match[2]);
            if (match[1] === '+') only.add(match[2]);
        }
        const hasForce = /\bforce\b/i.test(text);
        return { ignore, only, hasForce };
    },

    cleanText: (text) => {
        return text
            .replace(/([+-])\{(\d{17,20})\}/g, '')
            .replace(/\bforce\b/i, '')
            .trim();
    },

    fetchJsonFromUrl: (url) => {
        if (!Utils.isValidUrl(url)) return Promise.resolve({ success: false, error: "Invalid URL" });
        return new Promise(resolve => {
            const req = https.get(url, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return resolve({ success: false, error: `HTTP ${res.statusCode}` });
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve({ success: true, data: JSON.parse(data) }); }
                    catch (e) { resolve({ success: false, error: "Malformed JSON" }); }
                });
            });
            req.on('error', (e) => resolve({ success: false, error: e.message }));
            req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
        });
    },

    log: (botId, message, type = "INFO") => {
        const timestamp = new Date().toLocaleTimeString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        const icons = { "INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "SUCCESS": "✅", "DEBUG": "🐛" };
        console.log(`[${timestamp}] [Bot ${botId}] ${icons[type] || ""} ${message}`);
    }
};

// ============================================================================
// 🧠 3. ROBUST EXTERNAL SERVICES
// ============================================================================

class AIService {
    constructor() {
        this.client = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
        this.model = this.client ? this.client.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;
        this.cache = new Map(); 
    }

    async generateVariations(originalText, count = 5) {
        const heuristics = [
            originalText,
            originalText.replace(/[.!]/g, '...'), 
            originalText.charAt(0).toLowerCase() + originalText.slice(1)
        ];

        if (!this.model || originalText.length < 5) return heuristics;
        
        const cacheKey = crypto.createHash('md5').update(originalText).digest('hex');
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

        const prompt = `
        ROLE: Expert Paraphraser.
        TASK: Generate ${count} variations of the input.
        RULES:
        1. Keep EXACT same language as input (Auto-Detect).
        2. Keep {name} placeholder.
        3. Output JSON Array of strings ONLY.
        INPUT: "${originalText}"
        `;

        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("AI Timeout")), 10000));
            const aiPromise = this.model.generateContent(prompt);
            
            const result = await Promise.race([aiPromise, timeoutPromise]);
            const response = await result.response.text();
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            
            if (!jsonMatch) return heuristics;

            const variations = JSON.parse(jsonMatch[0]);
            const final = Array.isArray(variations) ? [...new Set([...variations, originalText])] : heuristics;
            
            if (this.cache.size >= CONFIG.MAX_AI_CACHE_SIZE) {
                const oldestKey = this.cache.keys().next().value;
                this.cache.delete(oldestKey);
            }
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
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            this.emailReady = true;
        }
    }

    async sendBackup(botId, reason, state, client) {
        const safeState = JSON.stringify(state, (key, value) => {
            if (value instanceof Set) return Array.from(value);
            return value;
        }, 2);

        const buffer = Buffer.from(safeState, 'utf-8');
        const filename = `backup_bot${botId}_${Date.now()}.json`;

        if (state.initiatorId && client) {
            try {
                const user = await client.users.fetch(state.initiatorId);
                const embed = new EmbedBuilder()
                    .setTitle(`🚨 EMERGENCY STOP: Bot ${botId}`)
                    .setColor(0xFF0000)
                    .setDescription(`**Reason:** ${reason}`)
                    .addFields({ name: "Error", value: state.lastError || "N/A" })
                    .setFooter({ text: "Use /resume with attachment" });

                await user.send({ embeds: [embed], files: [{ attachment: buffer, name: filename }] });
                Utils.log(botId, `Backup sent to DM: ${user.tag}`, "SUCCESS");
                return { success: true, method: 'DM' };
            } catch (e) {}
        }

        if (this.emailReady) {
            try {
                await this.transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: CONFIG.TARGET_EMAIL,
                    subject: `🚨 STOP: Bot ${botId} - ${reason}`,
                    text: `Reason: ${reason}\nError: ${state.lastError}`,
                    attachments: [{ filename: filename, content: safeState }]
                });
                Utils.log(botId, "Backup sent via Email.", "SUCCESS");
                return { success: true, method: 'EMAIL' };
            } catch (e) {}
        }

        console.error(`\n[Bot ${botId}] BACKUP DUMP:\n${safeState}\n`);
        return { success: false, method: 'CONSOLE' };
    }
}

// ============================================================================
// 💾 4. STATE MANAGER
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
            active: false,
            quarantine: false,
            lastError: null,
            text: "",
            variations: [],
            attachments: [],
            queue: [],
            ignore: new Set(), 
            only: new Set(),
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            currentAnnounceGuildId: null,
            privacyMode: 'public', 
            initiatorId: null,     
            activityLog: [],
            lastActivityTimestamp: Date.now(),
            circuitBreakerActiveUntil: null, 
            guildData: {} 
        };
    }

    loadInitialState() {
        try {
            if (!fs.existsSync(this.filePath)) return this.getDefaultState();
            const raw = fs.readFileSync(this.filePath, "utf8");
            const data = JSON.parse(raw);
            
            data.ignore = new Set(data.ignore || []);
            data.only = new Set(data.only || []);
            
            for (const guildId in data.guildData) {
                const g = data.guildData[guildId];
                g.processedMembers = new Set(g.processedMembers || []);
                g.blockedDMs = new Set(g.blockedDMs || []);
            }

            if (data.active && (!data.queue || data.queue.length === 0)) {
                data.active = false;
                data.quarantine = false;
            }

            return { ...this.getDefaultState(), ...data };
        } catch (error) {
            return this.getDefaultState();
        }
    }

    saveImmediate() {
        const serializableState = {
            ...this.state,
            ignore: [...this.state.ignore],
            only: [...this.state.only],
            guildData: {}
        };

        for (const [gid, gdata] of Object.entries(this.state.guildData)) {
            serializableState.guildData[gid] = {
                ...gdata,
                processedMembers: [...gdata.processedMembers],
                blockedDMs: [...gdata.blockedDMs],
                failedQueue: gdata.failedQueue.slice(-CONFIG.MAX_STATE_HISTORY)
            };
        }

        const json = JSON.stringify(serializableState, null, 2);

        fs.writeFile(this.tempFilePath, json, (err) => {
            if (err) return Utils.log(this.botId, `Write Fail: ${err.message}`, "ERROR");
            fs.rename(this.tempFilePath, this.filePath, (err) => {
                if (err) Utils.log(this.botId, `Rename Fail: ${err.message}`, "ERROR");
            });
        });
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveImmediate();
            this.saveTimer = null;
        }, CONFIG.STATE_SAVE_DEBOUNCE_MS);
    }

    async modify(callback) {
        await callback(this.state);
        this.scheduleSave();
    }

    forceSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveImmediate();
    }
}

// ============================================================================
// 🧱 5. CORE LOGIC
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
                GatewayIntentBits.GuildMembers, 
                GatewayIntentBits.GuildPresences, 
                GatewayIntentBits.DirectMessages, 
                GatewayIntentBits.MessageContent
            ],
            partials: [
                Partials.Channel, 
                Partials.Message, 
                Partials.GuildMember, 
                Partials.User, 
                Partials.Reaction
            ],
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
        this.lastEmbedRecovery = 0;

        setInterval(() => this.runWatchdog(), 60000);
    }

    addActivityLog(message, type = 'INFO') {
        Utils.log(this.id, message, type);
        const timestamp = new Date().toLocaleTimeString('pt-BR', { timeZone: CONFIG.TIMEZONE, hour12: false });
        const icons = { "INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "SUCCESS": "✅", "PAUSE": "⏸️", "SLEEP": "💤", "CIRCUIT": "🛡️" };
        
        const logEntry = {
            time: timestamp,
            icon: icons[type] || "•",
            message: message.substring(0, 45) 
        };

        this.logBuffer.unshift(logEntry);
        if (this.logBuffer.length > 5) this.logBuffer.pop();

        this.stateManager.modify(s => {
            s.activityLog = this.logBuffer;
            s.lastActivityTimestamp = Date.now();
        });
    }

    getBotStatus() {
        const s = this.stateManager.state;
        if (s.quarantine) return { emoji: "🚨", text: "Quarantined" };
        
        if (s.circuitBreakerActiveUntil && Date.now() < s.circuitBreakerActiveUntil) {
            const minLeft = Math.ceil((s.circuitBreakerActiveUntil - Date.now()) / 60000);
            return { emoji: "🛡️", text: `Cooling (${minLeft}m)` };
        }

        if (!s.active && s.queue.length > 0) {
            const hour = parseInt(new Intl.DateTimeFormat('en-US', { hour:'numeric', hour12:false, timeZone:CONFIG.TIMEZONE }).format(new Date()));
            if (hour >= 3 && hour <= 8) return { emoji: "💤", text: "Sleeping" };
            return { emoji: "⏸️", text: "Paused" };
        }
        if (!s.active) return { emoji: "⚪", text: "Idle" };
        
        const timeSince = Date.now() - s.lastActivityTimestamp;
        if (timeSince > 90000) return { emoji: "⏳", text: "Waiting" }; 
        
        return { emoji: "🟢", text: "Active" };
    }

    runWatchdog() {
        const wsStatus = this.client.ws.status; 
        const isFrozen = this.stateManager.state.active && (Date.now() - this.lastActivityTime > CONFIG.INACTIVITY_THRESHOLD);
        
        if (wsStatus !== 0) {
             this.addActivityLog(`WS Unstable (${wsStatus}). Reconnecting.`, "WARN");
             this.client.destroy();
             this.client.login(this.token);
        } else if (isFrozen) {
            this.addActivityLog("Logic Freeze. Restarting Worker.", "WARN");
            this.startWorker();
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
            this.addActivityLog(`Starting ${minutes}m wait...`, "INFO");
            const steps = minutes;
            const remainder = ms % 60000;

            for (let i = 0; i < steps; i++) {
                if (!this.stateManager.state.active || this.stateManager.state.quarantine) return;
                await new Promise(r => setTimeout(r, 60000));
                this.lastActivityTime = Date.now();
                if ((i + 1) % 3 === 0) this.addActivityLog(`... ${i + 1}/${steps}m elapsed`, "INFO");
            }
            if (remainder > 0) await new Promise(r => setTimeout(r, remainder));
        } else {
            const chunks = Math.ceil(ms / 1000);
            for (let i = 0; i < chunks; i++) {
                if (!this.stateManager.state.active || this.stateManager.state.quarantine) return;
                await new Promise(r => setTimeout(r, 1000));
            }
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
        if (!s.guildData[guildId]) {
            s.guildData[guildId] = { processedMembers: new Set(), blockedDMs: new Set(), failedQueue: [], pendingQueue: [] };
        }
        return s.guildData[guildId];
    }

    async sendStealthDM(user, rawText, attachments, variations) {
        this.lastActivityTime = Date.now();
        let dmChannel;

        try { dmChannel = user.dmChannel || await user.createDM(); } 
        catch (e) { return { success: false, reason: "closed" }; }

        const textTemplate = (variations?.length > 0) ? variations[Math.floor(Math.random() * variations.length)] : rawText;
        const finalText = Utils.personalizeText(textTemplate, user);
        
        if (!finalText && (!attachments || attachments.length === 0)) return { success: false, reason: "empty" };

        const shouldType = Math.random() < 0.80; 
        if (shouldType && finalText) {
            const typeTime = this.calculateTypingTime(finalText.length);
            try {
                await dmChannel.sendTyping();
                if (typeTime > 9000) {
                    const keep = setInterval(() => dmChannel.sendTyping().catch(()=>{}), 8000);
                    await this.wait(typeTime);
                    clearInterval(keep);
                } else {
                    await this.wait(typeTime);
                }
                
                if (!this.stateManager.state.active) return { success: false, reason: "aborted" };

            } catch(e) {}
        } else {
            await this.wait(1500 + Math.random() * 2000); 
        }

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
                if (code === 50007) return { success: false, reason: "closed" };
                if (err.retry_after) { 
                    this.addActivityLog(`429 Rate Limit: ${err.retry_after}s`, "WARN");
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
    }

    async workerLoop() {
        this.addActivityLog("Worker Started", "INFO");
        
        const circuit = { closed: 0, network: 0, successStreak: 0 };
        const recentResults = []; 
        
        try {
            while (this.stateManager.state.active && this.stateManager.state.queue.length > 0) {
                const state = this.stateManager.state;
                
                if (state.circuitBreakerActiveUntil && Date.now() < state.circuitBreakerActiveUntil) {
                    const waitMs = state.circuitBreakerActiveUntil - Date.now();
                    this.addActivityLog(`Circuit Cooling: ${Math.ceil(waitMs/60000)}m left`, "CIRCUIT");
                    await this.wait(waitMs);
                    await this.stateManager.modify(s => s.circuitBreakerActiveUntil = null);
                }

                const batchSize = Math.floor(Math.random() * (CONFIG.BATCH_SIZE_MAX - CONFIG.BATCH_SIZE_MIN + 1)) + CONFIG.BATCH_SIZE_MIN;
                const guild = this.client.guilds.cache.get(state.currentAnnounceGuildId);

                for (let i = 0; i < batchSize; i++) {
                    if (!state.active || state.queue.length === 0 || state.quarantine) break;
                    
                    if (state.circuitBreakerActiveUntil) break; 

                    const limitCheck = this.checkHourlyLimit();
                    if (limitCheck.exceeded) await this.wait(limitCheck.waitTime + 10000);

                    const userId = state.queue.shift();
                    await this.stateManager.modify(() => {}); 

                    if (guild) {
                        try {
                            await guild.members.fetch(userId); 
                        } catch (e) {
                            Utils.log(this.id, `User ${userId} left. Skipping.`, "DEBUG");
                            await this.stateManager.modify(s => { s.guildData[s.currentAnnounceGuildId].processedMembers.add(userId); });
                            continue; 
                        }
                    }

                    let user;
                    try { user = await this.client.users.fetch(userId); } catch (e) { continue; }

                    const gd = await this.ensureGuildData(state.currentAnnounceGuildId);

                    if (user.bot || Utils.isSuspiciousAccount(user) || gd.blockedDMs.has(userId)) continue;

                    const result = await this.sendStealthDM(user, state.text, state.attachments, state.variations);
                    this.sendsThisHour++;

                    recentResults.push(result.reason === 'closed' ? 1 : 0);
                    if (recentResults.length > 50) recentResults.shift();
                    const rejectionRate = recentResults.reduce((a, b) => a + b, 0) / recentResults.length;

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

                    if (state.quarantine) {
                        const res = await this.recoveryService.sendBackup(this.id, "QUARANTINE", state, this.client);
                        this.addActivityLog(`Backup sent: ${res.method}`, "WARN");
                        break;
                    }

                    if (circuit.closed >= CONFIG.THRESHOLDS.CONSECUTIVE_CLOSED_DMS) {
                        await this.stateManager.modify(s => s.circuitBreakerActiveUntil = Date.now() + CONFIG.CLOSED_DM_COOLING_MS);
                        this.addActivityLog(`Circuit: Privacy. Cooling triggered.`, "CIRCUIT");
                        await this.updateEmbed();
                        circuit.closed = 0;
                        break; // Exit Batch -> Top of Loop handles Wait
                    }
                    if (circuit.network >= CONFIG.THRESHOLDS.CONSECUTIVE_NET_ERRORS) {
                        this.addActivityLog("Circuit: Network. Waiting 1m", "CIRCUIT");
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

                if (state.active && state.queue.length > 0 && !state.circuitBreakerActiveUntil) {
                    const rate = recentResults.reduce((a,b)=>a+b,0) / recentResults.length || 0;
                    let range = CONFIG.PAUSE_NORMAL;
                    if (rate > CONFIG.THRESHOLDS.CRITICAL_REJECTION_RATE) range = CONFIG.PAUSE_CRITICAL;
                    else if (rate > 0.25) range = CONFIG.PAUSE_CAUTION;

                    const pause = Math.floor(Math.random() * (range.MAX - range.MIN + 1)) + range.MIN;
                    this.addActivityLog(`Batch Pause: ${pause}m`, "PAUSE");
                    await this.wait(pause * 60 * 1000);
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
                if (Math.random() < 0.05) {
                    const replies = ["👀", "nice", "top", "brabo", "🔥"];
                    await target.reply(replies[Math.floor(Math.random() * replies.length)]);
                } else {
                    await target.react(["👍", "🔥", "👀"][Math.floor(Math.random() * 3)]);
                }
            }
        } catch (e) {}
    }

    async finalizeWorker() {
        const s = this.stateManager.state;
        if (s.queue.length > 0 && s.currentAnnounceGuildId && !s.quarantine) {
            await this.stateManager.modify(st => {
                const g = st.guildData[st.currentAnnounceGuildId];
                if (g) g.pendingQueue.push(...st.queue);
                st.queue = [];
            });
        }
        if (!s.quarantine) await this.stateManager.modify(st => st.active = false);
        await this.updateEmbed();
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
                .setTitle(`${status.emoji} Bot ${this.id} | V9.6 APEX`)
                .setDescription(`**Status:** ${status.text}`)
                .setColor(s.quarantine ? 0xFF0000 : status.text === 'Active' ? 0x00FF00 : 0xFFAA00)
                .addFields(
                    { name: "📊 Stats", value: `✅ ${stats.success} | 🚫 ${stats.closed} | ❌ ${stats.fail} | ⏳ ${s.queue.length}`, inline: false },
                    { name: "🔍 Activity Log", value: `\`\`\`${logs}\`\`\``, inline: false },
                    { name: "⏱️ Last Activity", value: timeText, inline: true }
                ).setTimestamp();
            if (s.quarantine) embed.addFields({ name: "🚨 Error", value: s.lastError || "?" });
            await msg.edit({ embeds: [embed] });
        } catch (e) {
            const now = Date.now();
            if (s.privacyMode === 'private' && s.initiatorId && (now - this.lastEmbedRecovery > 300000)) {
                try {
                    const u = await this.client.users.fetch(s.initiatorId);
                    const m = await u.send({ content: "Panel restored." });
                    this.stateManager.modify(st => st.progressMessageRef = { channelId: m.channel.id, messageId: m.id });
                    this.lastEmbedRecovery = now;
                } catch {}
            }
        }
    }

    startWorker() {
        if (!this.workerRunning && this.stateManager.state.active) {
            this.workerRunning = true;
            this.workerLoop();
        }
    }

    async start() {
        this.client.on(Events.ClientReady, async () => {
            Utils.log(this.id, `Online: ${this.client.user.tag}`, "SUCCESS");
            
            this.startPresenceLoop();
            this.startSleepCycle();
            
            const cmdAdapter = new CommandContext(this);
            this.client.on('interactionCreate', i => cmdAdapter.handleInteraction(i));
            this.client.on('messageCreate', m => cmdAdapter.handleMessage(m));

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

    startSleepCycle() {
        setInterval(() => {
            const d = new Date();
            const hour = parseInt(new Intl.DateTimeFormat('en-US', { hour:'numeric', hour12:false, timeZone:CONFIG.TIMEZONE }).format(d));
            const shouldSleep = hour >= 3 && hour <= 8;
            const state = this.stateManager.state;
            if (shouldSleep && state.active) {
                this.addActivityLog("Sleep Cycle: Pausing.", "SLEEP");
                this.stateManager.modify(s => { s.active = false; s.circuitBreakerActiveUntil = null; });
            } else if (!shouldSleep && !state.active && state.queue.length > 0 && !state.quarantine) {
                this.addActivityLog("Sleep Cycle: Waking up.", "INFO");
                this.stateManager.modify(s => s.active = true);
                this.startWorker();
            }
        }, 20 * 60 * 1000);
    }
}

// ============================================================================
// 🔌 6. COMMAND ADAPTER
// ============================================================================

class CommandContext {
    constructor(bot) { this.bot = bot; }

    async handleInteraction(i) {
        if (!i.isChatInputCommand() || !i.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        try {
            const opts = { text: i.options.getString('text'), attach: i.options.getAttachment('file')?.url, filter: i.options.getString('filter'), file: i.options.getAttachment('file')?.url };
            await this.router(i, i.commandName, opts);
        } catch (e) { console.error(`Cmd Error: ${e.message}`); i.reply({ content: "Error", flags: MessageFlags.Ephemeral }).catch(()=>{}); }
    }

    async handleMessage(m) {
        if (m.author.bot) return;
        if (!m.content) return; 
        if (!m.content.startsWith('!')) return;
        
        let member = m.member;
        if (!member && m.guild) {
            try { member = await m.guild.members.fetch(m.author.id); } catch(e) {}
        }
        
        if (!member?.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        
        Utils.log(this.bot.id, `CMD RX: ${m.content}`, "DEBUG");
        
        const args = m.content.slice(1).trim().split(/ +/);
        const cmd = args.shift().toLowerCase();
        const full = m.content.slice(cmd.length + 1).trim();
        
        try { await this.router(m, cmd, { text: full, attach: m.attachments.first()?.url, filter: full, file: m.attachments.first()?.url }); } 
        catch (e) { console.error(`Msg Cmd Error: ${e.message}`); }
    }

    async router(ctx, cmd, opts) {
        const isSlash = !!ctx.isChatInputCommand;
        const reply = async (msg) => isSlash ? (ctx.deferred ? ctx.editReply(msg) : ctx.reply(msg)) : ctx.reply(msg);
        const initiatorId = isSlash ? ctx.user.id : ctx.author.id;
        
        if (isSlash && !ctx.deferred) await ctx.deferReply({ flags: MessageFlags.Ephemeral });

        if (cmd === 'announce') {
            if (this.bot.stateManager.state.active) return reply("❌ Busy.");
            
            // 🔥 V9.6 FIX: Declarar gd ANTES de usar
            const gd = await this.bot.ensureGuildData(ctx.guild.id);
            
            let rawText = opts.text || "";
            // 🔥 V9.6 FIX: Remoção de 'cleanedText' na destructuring (Bug Visual)
            const { ignore, only, hasForce } = Utils.parseFilters(opts.filter || rawText);
            
            let messageText = isSlash ? rawText : Utils.cleanText(rawText);
            if (isSlash && messageText) messageText = messageText.replace(/ {2,}/g, '\n\n').replace(/ ([*•+]) /g, '\n$1 ').replace(/\n /g, '\n');

            const attachments = (opts.attach && Utils.isValidUrl(opts.attach)) ? [opts.attach] : [];
            
            if (!messageText && attachments.length === 0) return reply("❌ Mensagem vazia.");

            const vars = await this.bot.aiService.generateVariations(messageText);
            
            try { await ctx.guild.members.fetch(); } catch(e){} 
            
            const queue = ctx.guild.members.cache.filter(m => !m.user.bot && !ignore.has(m.id) && !gd.blockedDMs.has(m.id) && !Utils.isSuspiciousAccount(m.user) && (!only.size || only.has(m.id))).map(m => m.id);
            
            if (!hasForce && (gd.pendingQueue.length || gd.failedQueue.length)) return reply("⚠️ Queue pending.");
            if (!queue.length) return reply("❌ No targets.");
            
            await this.bot.stateManager.modify(s => {
                s.active = true; s.quarantine = false; s.text = messageText; s.variations = vars; s.attachments = attachments; s.queue = queue; s.currentAnnounceGuildId = ctx.guild.id; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.privacyMode = isSlash ? 'private' : 'public'; s.initiatorId = initiatorId; s.activityLog = []; s.lastActivityTimestamp = Date.now();
                if (hasForce) { s.guildData[ctx.guild.id].pendingQueue = []; s.guildData[ctx.guild.id].failedQueue = []; }
            });
            
            const msg = await (isSlash ? (await ctx.user.createDM()).send(`🚀 Started: ${queue.length}`) : ctx.reply(`🚀 Started: ${queue.length}`));
            await this.bot.stateManager.modify(s => s.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id });
            if (isSlash) reply("✅ Check DM.");
            this.bot.startWorker();
        } 
        else if (cmd === 'stop') { await this.bot.stateManager.modify(s => s.active = false); reply("🛑 Stopped."); }
        else if (cmd === 'status') {
            const s = this.bot.stateManager.state;
            reply({ embeds: [new EmbedBuilder().setTitle("Status").setDescription(`Active: ${s.active}\nQueue: ${s.queue.length}\nQuarantine: ${s.quarantine}`)] });
        }
        else if (cmd === 'update') {
            const gd = await this.bot.ensureGuildData(ctx.guild.id);
            try { await ctx.guild.members.fetch(); } catch(e){}
            const known = new Set([...gd.processedMembers, ...gd.blockedDMs, ...gd.failedQueue, ...gd.pendingQueue, ...this.bot.stateManager.state.queue]);
            const newMems = ctx.guild.members.cache.filter(m => !m.user.bot && !known.has(m.id) && !Utils.isSuspiciousAccount(m.user)).map(m => m.id);
            if (!newMems.length) return reply("✅ Nothing new.");
            await this.bot.stateManager.modify(st => st.queue.push(...newMems));
            reply(`🔄 Added +${newMems.length}.`);
        }
        else if (cmd === 'resume') {
            if (this.bot.stateManager.state.active) return reply("⚠️ Active.");
            let backup = null;
            if (opts.file) { const res = await Utils.fetchJsonFromUrl(opts.file); if (res.success) backup = res.data; }
            const gd = await this.bot.ensureGuildData(ctx.guild.id);
            let q = [...new Set([...this.bot.stateManager.state.queue, ...gd.pendingQueue, ...gd.failedQueue, ...(backup?.queue || [])])].filter(id => !gd.blockedDMs.has(id));
            if (!q.length) return reply("✅ Empty.");
            await this.bot.stateManager.modify(s => {
                s.active = true; s.quarantine = false; s.queue = q; s.currentAnnounceGuildId = ctx.guild.id; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.guildData[ctx.guild.id].pendingQueue = []; s.initiatorId = initiatorId; 
                if (backup) { 
                    if(backup.text) s.text = backup.text; 
                    if(backup.variations) s.variations = backup.variations; 
                    if(backup.attachments) s.attachments = backup.attachments;
                }
            });
            const s = this.bot.stateManager.state;
            if (!s.text && (!s.attachments || s.attachments.length === 0)) return reply("❌ Backup corrupted (Empty).");

            const msg = await (isSlash ? (await ctx.user.createDM()).send(`🔄 Resumed: ${q.length}`) : ctx.reply(`🔄 Resumed: ${q.length}`));
            await this.bot.stateManager.modify(s => s.progressMessageRef = { channelId: msg.channel.id, messageId: msg.id });
            if (isSlash) reply("✅ Resumed.");
            this.bot.startWorker();
        }
        else if (cmd === 'reset') {
            await this.bot.stateManager.modify(s => { s.active = false; s.quarantine = false; s.queue = []; s.lastError = null; s.currentRunStats = { success: 0, fail: 0, closed: 0 }; s.activityLog = []; s.circuitBreakerActiveUntil = null; });
            reply("☢️ Reset.");
        }
        else if (cmd === 'lastbackup') {
            const s = this.bot.stateManager.state;
            const gd = s.guildData[ctx.guild.id];
            const hasData = gd && (gd.processedMembers.size > 0 || gd.pendingQueue.length > 0 || gd.failedQueue.length > 0);
            if (!hasData) return reply("✅ No data.");
            
            const totalQueue = gd ? (gd.pendingQueue.length + gd.failedQueue.length) : 0;
            const lastActivity = new Date(s.lastActivityTimestamp).toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
            const ageHours = Math.floor((Date.now() - s.lastActivityTimestamp) / 3600000);
            const ageTag = ageHours > 24 ? ` ⚠️ (${Math.floor(ageHours/24)}d old)` : "";

            const embed = new EmbedBuilder().setTitle("💾 Backup Found").setColor(0x00AEEF).addFields(
                { name: "📅 Last Active", value: `${lastActivity}${ageTag}`, inline: true },
                { name: "⏳ Pending", value: `${totalQueue}`, inline: true },
                { name: "📊 Stats", value: `✅ ${s.currentRunStats.success} | 🚫 ${s.currentRunStats.closed}`, inline: false }
            ).setFooter({ text: "Recover?" });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('backup_sim').setLabel('✅ Sim').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('backup_nao').setLabel('❌ Não').setStyle(ButtonStyle.Secondary)
            );
            
            const msg = await (isSlash ? ctx.editReply({ embeds: [embed], components: [row] }) : ctx.reply({ embeds: [embed], components: [row] }));
            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
            
            collector.on('collect', async i => {
                if (i.user.id !== initiatorId) return i.reply({ content: "⛔ Denied.", flags: MessageFlags.Ephemeral });
                if (i.customId === 'backup_sim') {
                    const safeState = JSON.stringify(s, (k, v) => v instanceof Set ? [...v] : v, 2);
                    const buffer = Buffer.from(safeState, 'utf-8');
                    const filename = `backup_guild${ctx.guild.id}_${Date.now()}.json`;
                    await i.update({ content: "📤 Sending...", embeds: [], components: [] });
                    try {
                        await i.user.send({ content: "💾 **Backup**", files: [{ attachment: buffer, name: filename }] });
                        if (!isSlash) await ctx.reply("✅ Sent to DM."); else await i.followUp({ content: "✅ Sent to DM.", flags: MessageFlags.Ephemeral });
                    } catch (e) {
                        if (!isSlash) await ctx.reply("❌ Check DM privacy."); else await i.followUp({ content: "❌ Check DM privacy.", flags: MessageFlags.Ephemeral });
                    }
                } else { await i.update({ content: "❌ Cancelled.", embeds: [], components: [] }); }
                collector.stop();
            });
        }
    }
}

// ============================================================================
// 🚀 BOOTSTRAPPER
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
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
        system: "V9.6 APEX REFINED",
        bots: bots.map(b => ({ id: b.id, q: b.stateManager.state.queue.length, active: b.stateManager.state.active }))
    }, null, 2));
}).listen(process.env.PORT || 8080, () => console.log(`🛡️ V9.6 ONLINE | PORT ${process.env.PORT || 8080}`));

process.on('SIGTERM', () => { bots.forEach(b => b.stateManager.forceSave()); process.exit(0); });