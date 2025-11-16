/*******************************************
 * Announce Bot - Persistência + 0.5s Delay
 * - Retoma envio após crash (progress.json)
 * - Delay de 500ms com adaptativo
 *******************************************/

require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ===== Configurações =====
const WORKER_COUNT = 3;
const PAGE_LIMIT = 1000;

// Delay seguro (0.5s)
const GLOBAL_MIN_DELAY = 400;
const GLOBAL_MAX_DELAY = 5000;
const GLOBAL_INITIAL = 500;

const WORKER_MIN_DELAY = 400;
const WORKER_MAX_DELAY = 5000;
const WORKER_INITIAL = 500;

const RETRY_LIMIT = 1;

// Persistência
const PROGRESS_FILE = "./progress.json";

// =========================

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

//===== ESTADOS DE EXECUÇÃO =====//
let sendQueue = []; 
let producingDone = false;
let stats = { totalQueued: 0, sent: 0, failed: 0, skippedBlocked: 0 };
let globalDelay = GLOBAL_INITIAL;
let lastSendTimestamp = 0;
let limiterLocked = false;
let workerDelays = Array.from({ length: WORKER_COUNT }, () => WORKER_INITIAL);
let blockedCache = new Set();

//===== PERSISTÊNCIA =====//

function saveProgress() {
    const data = {
        queue: sendQueue.map(q => q.id),
        processed: {
            sent: stats.sent,
            failed: stats.failed,
            skippedBlocked: stats.skippedBlocked
        }
    };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function loadProgress() {
    if (!fs.existsSync(PROGRESS_FILE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(PROGRESS_FILE));
        return data;
    } catch {
        return null;
    }
}

function clearProgress() {
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

//===== HELPERS =====//

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function acquireSendSlot() {
    while (true) {
        const now = Date.now();
        if (now - lastSendTimestamp >= globalDelay && !limiterLocked) {
            limiterLocked = true;
            return;
        }
        await wait(20);
    }
}

function releaseSendSlot() {
    lastSendTimestamp = Date.now();
    limiterLocked = false;
}

function globalOnSuccess() {
    globalDelay = Math.max(GLOBAL_MIN_DELAY, Math.round(globalDelay * 0.97));
}

function globalOnRateLimit() {
    globalDelay = Math.min(GLOBAL_MAX_DELAY, Math.round(globalDelay * 1.5));
}

function workerOnSuccess(idx) {
    workerDelays[idx] = Math.max(WORKER_MIN_DELAY, Math.round(workerDelays[idx] * 0.95));
}

function workerOnRateLimit(idx) {
    workerDelays[idx] = Math.min(WORKER_MAX_DELAY, Math.round(workerDelays[idx] * 1.4));
}

//===== ENVIO DM + ADAPTATIVO =====//

async function trySendDM(member, payload, workerIndex) {
    if (blockedCache.has(member.user.id)) {
        stats.skippedBlocked++;
        return { ok: false };
    }

    for (let attempt = 1; attempt <= RETRY_LIMIT + 1; attempt++) {
        try {
            await acquireSendSlot();
            await member.send(payload);
            releaseSendSlot();

            globalOnSuccess();
            workerOnSuccess(workerIndex);
            return { ok: true };

        } catch (err) {
            if (limiterLocked) {
                limiterLocked = false;
                lastSendTimestamp = Date.now();
            }

            const code = err.code ?? err?.status ?? null;

            // DM fechada
            if (code === 50007 || code === 50013) {
                blockedCache.add(member.user.id);
                stats.skippedBlocked++;
                return { ok: false };
            }

            // Rate limit
            if (code === 429) {
                globalOnRateLimit();
                workerOnRateLimit(workerIndex);
                await wait(globalDelay);
                continue;
            }

            await wait(800 * attempt);
        }
    }

    stats.failed++;
    return { ok: false };
}

//===== WORKER LOOP =====//

async function workerLoop(idx) {
    while (true) {
        const job = sendQueue.shift();
        if (!job) {
            if (producingDone) return;
            await wait(100);
            continue;
        }

        await wait(workerDelays[idx]);
        const result = await trySendDM(job.member, job.payload, idx);

        if (result.ok) stats.sent++;
        saveProgress();
    }
}

//===== PARSER =====//

function parseUserSelectors(text) {
    const ignore = new Set();
    const only = new Set();
    const regex = /([+-])\{(\d+)\}/g;
    let match;

    while ((match = regex.exec(text))) {
        const type = match[1];
        const id = match[2];
        if (type === "-") ignore.add(id);
        else only.add(id);
    }

    const cleaned = text.replace(regex, "").trim();
    return { cleaned, ignore, only };
}

//===== PRODUCER (com persistência) =====//

async function produceQueue(guild, cleanedText, attachments, ignore, only, command, resumePreviousQueue) {

    if (resumePreviousQueue) {
        // Remontar objetos de fila
        for (const id of resumePreviousQueue.queue) {
            const member = await guild.members.fetch(id).catch(() => null);
            if (!member) continue;

            const payload = {};
            if (cleanedText) payload.content = cleanedText;
            if (attachments.length > 0) payload.files = attachments;

            sendQueue.push({ id, member, payload });
        }
        stats = resumePreviousQueue.processed;
        producingDone = true;
        return;
    }

    let after = undefined;

    while (true) {
        const members = await guild.members.list({ limit: PAGE_LIMIT, after });

        if (!members || members.size === 0) break;

        for (const member of members.values()) {
            if (member.user.bot) continue;

            if (command === "announce" && ignore.has(member.user.id)) continue;
            if (command === "for" && !only.has(member.user.id)) continue;

            const payload = {};
            if (cleanedText) payload.content = cleanedText;
            if (attachments.length > 0) payload.files = attachments;

            sendQueue.push({ id: member.user.id, member, payload });
            stats.totalQueued++;
        }

        after = members.last().user.id;
        saveProgress();
    }

    producingDone = true;
}

//===== MAIN MESSAGE HANDLER =====//

client.on("messageCreate", async message => {
    if (!message.content.startsWith("!announce") && !message.content.startsWith("!announcefor")) return;
    if (message.author.bot) return;

    const command = message.content.startsWith("!announcefor") ? "for" : "announce";

    const rawText = message.content.replace("!announcefor", "").replace("!announce", "").trim();
    const { cleaned, ignore, only } = parseUserSelectors(rawText);

    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!cleaned && attachments.length === 0)
        return message.reply("Use: `!announce mensagem -{id}` ou `!announcefor mensagem +{id}`");

    const guild = message.guild;
    if (!guild) return message.reply("Use o comando dentro de um servidor.");

    // Reset state
    sendQueue = [];
    producingDone = false;
    blockedCache.clear();
    globalDelay = GLOBAL_INITIAL;
    workerDelays = Array.from({ length: WORKER_COUNT }, () => WORKER_INITIAL);

    // Load progress if exists
    const saved = loadProgress();
    let resume = null;

    if (saved) {
        message.reply("⚠️ Execução anterior encontrada. Deseja continuar de onde parou? (sim/não)");

        const filter = m => m.author.id === message.author.id;
        const reply = await message.channel.awaitMessages({ filter, max: 1, time: 15000 }).catch(() => null);

        const ans = reply?.first()?.content?.toLowerCase() || "não";

        if (ans === "sim") {
            resume = saved;
            message.reply("🔁 Retomando execução anterior...");
        } else {
            clearProgress();
            message.reply("🆕 Iniciando novo envio...");
        }
    } else {
        message.reply("📢 Preparando envio...");
    }

    produceQueue(guild, cleaned, attachments, ignore, only, command, resume);

    const workerPromises = [];
    for (let i = 0; i < WORKER_COUNT; i++) workerPromises.push(workerLoop(i));

    await Promise.all(workerPromises);

    clearProgress();

    message.reply(`✅ Finalizado!\nEnviadas: ${stats.sent}\nFalhas: ${stats.failed}\nDM fechada: ${stats.skippedBlocked}`);
});

//===== LOGIN =====//

client.on("ready", () => console.log(`Bot online como ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
