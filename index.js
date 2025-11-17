require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ================================
// CONFIGURAÇÕES
// ================================
const CHUNK_SIZE = 30;        // Pequeno = seguro no Railway
const WORKERS = 3;            // 3 workers paralelos
const DELAY = 500;            // 0.5s por mensagem
const RETRY_LIMIT = 2;
// ================================


// ===========================================
// Funções de persistência (queue.json)
// ===========================================
function loadQueue() {
    if (!fs.existsSync("queue.json")) {
        return {
            active: false,
            guildId: null,
            message: null,
            attachments: [],
            ignore: [],
            only: [],
            after: null,
            queue: [],
            sent: [],
            failed: []
        };
    }
    return JSON.parse(fs.readFileSync("queue.json", "utf-8"));
}

function saveQueue(data) {
    fs.writeFileSync("queue.json", JSON.stringify(data, null, 2));
}


// ===========================================
// Discord Client
// ===========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

client.on("clientReady", () => {
    console.log(`Bot online como ${client.user.tag}`);
    resumeIfNeeded();
});


// ===========================================
// Util
// ===========================================
function wait(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function sendDM(member, payload) {
    for (let i = 1; i <= RETRY_LIMIT; i++) {
        try {
            await member.send(payload);
            return { ok: true };
        } catch (err) {
            console.log(`Erro enviando DM → ${member.user.tag}: Tentativa ${i}`);
            await wait(1500 * i);

            if (err.message?.includes("Cannot send messages")) {
                return { ok: false, dmClosed: true };
            }
        }
    }
    return { ok: false, dmClosed: false };
}


// ===========================================
// Producer — adiciona IDs na fila devagar
// ===========================================
async function producer(guild, data) {
    console.log("Producer iniciado...");

    while (true) {
        const page = await guild.members.list({
            limit: CHUNK_SIZE,
            after: data.after || undefined
        });

        if (page.size === 0) {
            console.log("Producer: fim da paginação");
            data.active = true;
            saveQueue(data);
            break;
        }

        for (const m of page.values()) {
            if (m.user.bot) continue;

            // filtros
            if (data.ignore.includes(m.user.id)) continue;
            if (data.only.length > 0 && !data.only.includes(m.user.id)) continue;

            data.queue.push(m.user.id);
        }

        const last = page.last();
        data.after = last.user.id;

        console.log(`Producer: carregado → ${data.queue.length} usuários.`);
        saveQueue(data);

        await wait(200); // evita Railway kill
    }
}


// ===========================================
// Worker — envia mensagens da fila
// ===========================================
async function worker(id) {
    console.log(`Worker ${id} iniciado.`);

    while (true) {
        const data = loadQueue();

        if (!data.active) {
            await wait(300);
            continue;
        }

        const uid = data.queue.shift();
        if (!uid) {
            await wait(300);
            continue;
        }

        saveQueue(data);

        try {
            const guild = client.guilds.cache.get(data.guildId);
            const member = await guild.members.fetch(uid);

            const payload = {};
            if (data.message) payload.content = data.message;
            if (data.attachments.length > 0) payload.files = data.attachments;

            const result = await sendDM(member, payload);

            const updated = loadQueue();

            if (result.ok) updated.sent.push(uid);
            else updated.failed.push(uid);

            saveQueue(updated);

        } catch (err) {
            const updated = loadQueue();
            updated.failed.push(uid);
            saveQueue(updated);
        }

        await wait(DELAY);
    }
}


// ===========================================
// Retomada automática
// ===========================================
async function resumeIfNeeded() {
    const data = loadQueue();

    if (!data.guildId) {
        console.log("Nenhum job pendente.");
        return;
    }

    console.log("Job pendente encontrado, retomando...");

    const guild = client.guilds.cache.get(data.guildId);

    // retomar producer se não finalizado
    if (!data.active) {
        producer(guild, data);
    }

    // iniciar workers
    for (let i = 0; i < WORKERS; i++) {
        worker(i);
    }
}


// ===========================================
// Parser de filtros -{id} +{id}
// ===========================================
function parseSelectors(text) {
    const ignore = [];
    const only = [];

    const regex = /([+-])\{(\d{5,30})\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const type = match[1];
        const id = match[2];
        if (type === "-") ignore.push(id);
        if (type === "+") only.push(id);
    }

    return {
        cleaned: text.replace(regex, "").trim(),
        ignore,
        only
    };
}


// ===========================================
// Comando principal
// ===========================================
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!announce") &&
        !message.content.startsWith("!announcefor")) return;

    if (message.author.bot) return;

    const isFor = message.content.startsWith("!announcefor");

    const raw = message.content
        .replace("!announcefor", "")
        .replace("!announce", "")
        .trim();

    const { cleaned, ignore, only } = parseSelectors(raw);

    const attachments = [...message.attachments.values()].map(a => a.url);

    const guild = message.guild;

    await message.reply("📢 Preparando envio…");

    const data = {
        active: false,
        guildId: guild.id,
        message: cleaned,
        attachments,
        ignore,
        only,
        after: null,
        queue: [],
        sent: [],
        failed: []
    };

    saveQueue(data);

    producer(guild, data);

    for (let i = 0; i < WORKERS; i++) {
        worker(i);
    }

    message.reply("🔄 Envio iniciado em modo seguro (Railway-Proof).");
});


// ===========================================
client.login(process.env.DISCORD_TOKEN);
