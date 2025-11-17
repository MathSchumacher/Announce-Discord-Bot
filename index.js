require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIGS SENSÍVEIS =====
const WORKERS = 3;            // 3 workers paralelos ultra seguros
const DELAY_BASE = 550;       // delay seguro e estável
const RETRY_LIMIT = 2;
const CHUNK_SIZE = 1000;
const PROGRESS_UPDATE_INTERVAL = 5000; // atualiza embed a cada 5s
const STATE_FILE = "./state.json";
// =============================

// Carrega estado persistente
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {
            active: false,
            guildId: null,
            text: "",
            attachments: [],
            ignore: [],
            only: [],
            queue: [],
            stats: { success: 0, fail: 0, closed: 0 },
            progressMessage: null,
            mode: "announce"
        };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// Criação do client
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

client.on("clientReady", () => {
    console.log(`Bot online como ${client.user.tag}`);

    // AUTO-RESUME
    if (state.active && state.queue.length > 0) {
        console.log("🔥 Retomando envio anterior...");
        startWorkers();
        startProgressUpdater();
    }
});

// ========= Utils =========
function wait(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function sendDM(member, payload) {
    for (let a = 1; a <= RETRY_LIMIT; a++) {
        try {
            await member.send(payload);
            return true;
        } catch (err) {
            if (err.code === 50007) return "closed";
            await wait(1200 * a);
        }
    }
    return false;
}

function parseSelectors(text) {
    const ignore = new Set();
    const only = new Set();
    const regex = /([+-])\{(\d{5,30})\}/g;

    let m;
    while ((m = regex.exec(text)) !== null) {
        if (m[1] === "-") ignore.add(m[2]);
        if (m[1] === "+") only.add(m[2]);
    }

    return {
        cleaned: text.replace(regex, "").trim(),
        ignore,
        only
    };
}

// ========= Embed de Progresso =========
async function updateProgressEmbed() {
    if (!state.progressMessage) return;

    const embed = new EmbedBuilder()
        .setTitle("📨 Envio em progresso")
        .setColor("#00AEEF")
        .addFields(
            { name: "Enviadas", value: `${state.stats.success}`, inline: true },
            { name: "Falhas", value: `${state.stats.fail}`, inline: true },
            { name: "DM fechada", value: `${state.stats.closed}`, inline: true },
            { name: "Restando", value: `${state.queue.length}`, inline: true }
        )
        .setTimestamp();

    try {
        await state.progressMessage.edit({ embeds: [embed] });
    } catch {}
}

function startProgressUpdater() {
    setInterval(() => {
        if (!state.active) return;
        updateProgressEmbed();
    }, PROGRESS_UPDATE_INTERVAL);
}

// ========= WORKERS =========
async function workerLoop(id) {
    console.log(`Worker ${id} iniciado.`);

    while (state.active && state.queue.length > 0) {
        const userId = state.queue.shift();
        saveState(state);

        const guild = await client.guilds.fetch(state.guildId);
        const member = await guild.members.fetch(userId).catch(() => null);

        if (!member || member.user.bot) continue;

        const payload = {};
        if (state.text) payload.content = state.text;
        if (state.attachments.length > 0) payload.files = state.attachments;

        const result = await sendDM(member, payload);

        if (result === true) state.stats.success++;
        else if (result === "closed") state.stats.closed++;
        else state.stats.fail++;

        saveState(state);

        await wait(DELAY_BASE);
    }

    console.log(`Worker ${id} finalizado.`);
}

function startWorkers() {
    for (let i = 0; i < WORKERS; i++) workerLoop(i);
}

// ========= COMANDO PRINCIPAL =========
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!announce") &&
        !message.content.startsWith("!announcefor"))
        return;

    if (message.author.bot) return;

    const mode = message.content.startsWith("!announcefor") ? "for" : "announce";

    const raw = message.content
        .replace("!announcefor", "")
        .replace("!announce", "")
        .trim();

    const parsed = parseSelectors(raw);

    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!parsed.cleaned && attachments.length === 0)
        return message.reply("Use `!announce texto -{id}` ou `!announcefor texto +{id}`");

    // Criar nova fila
    const guild = message.guild;
    await guild.members.fetch();

    let queue = [];

    guild.members.cache.forEach(m => {
        if (m.user.bot) return;

        if (mode === "announce" && parsed.ignore.has(m.id)) return;
        if (mode === "for" && !parsed.only.has(m.id)) return;

        queue.push(m.id);
    });

    // Estado persistente
    state = {
        active: true,
        guildId: guild.id,
        text: parsed.cleaned,
        mode,
        attachments,
        ignore: [...parsed.ignore],
        only: [...parsed.only],
        queue,
        stats: { success: 0, fail: 0, closed: 0 },
        progressMessage: null
    };

    saveState(state);

    // Envia a mensagem de progresso
    const msg = await message.reply("📢 Preparando envio…");
    state.progressMessage = msg;
    saveState(state);

    await wait(800);

    await msg.edit("🔄 Envio iniciado em modo seguro (Railway-Proof).");

    // INICIA TUDO
    startWorkers();
    startProgressUpdater();
});

// ========= LOGIN =========
client.login(process.env.DISCORD_TOKEN);
