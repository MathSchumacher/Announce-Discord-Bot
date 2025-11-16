require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ===== CONFIGURAÇÕES =====
const DELAY_BASE = 500; // 0.5s — seguro e estável
const RETRY_LIMIT = 2;
const CHUNK_SIZE = 1000;
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

client.on("ready", () => {
    console.log(`Bot online como ${client.user.tag}`);
});

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendDM(member, payload) {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await member.send(payload);
            return true;
        } catch (err) {
            console.log(
                `Falha DM (${member.user.tag}) tentativa ${attempt}: ${err.message}`
            );
            await wait(1500 * attempt);
        }
    }
    return false;
}

// ========= SUPORTE A -{id} E +{id} ==========
function parseUserSelectors(text) {
    const ignore = new Set();
    const only = new Set();

    const regex = /([+-])\{(\d{5,30})\}/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const sign = match[1];
        const id = match[2];

        if (sign === "-") ignore.add(id);
        if (sign === "+") only.add(id);
    }

    const cleaned = text.replace(regex, "").trim();
    return { cleaned, ignore, only };
}
// ===========================================

client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!announce") &&
        !message.content.startsWith("!announcefor")) return;

    if (message.author.bot) return;

    const isFor = message.content.startsWith("!announcefor");

    const rawText = message.content
        .replace("!announcefor", "")
        .replace("!announce", "")
        .trim();

    const { cleaned, ignore, only } = parseUserSelectors(rawText);

    const attachments = [...message.attachments.values()].map(a => a.url);

    if (!cleaned && attachments.length === 0) {
        return message.reply(
            "Use:\n`!announce texto -{id}`\nou\n`!announcefor texto +{id}`"
        );
    }

    const guild = message.guild;
    if (!guild) return message.reply("Use esse comando dentro de um servidor.");

    await message.reply("📢 Iniciando envio…");

    let sucesso = 0;
    let falha = 0;
    let dmsFechadas = 0;

    let after = undefined;

    while (true) {
        const members = await guild.members.list({
            limit: CHUNK_SIZE,
            after: after
        });

        if (members.size === 0) break;

        for (const member of members.values()) {
            if (member.user.bot) continue;

            const uid = member.user.id;

            if (!isFor && ignore.has(uid)) continue;
            if (isFor && !only.has(uid)) continue;

            const payload = {};
            if (cleaned) payload.content = cleaned;
            if (attachments.length > 0) payload.files = attachments;

            const ok = await sendDM(member, payload);

            if (ok) {
                sucesso++;
            } else {
                falha++;
                dmsFechadas++;
            }

            console.log(
                `DM → ${member.user.tag} | OK: ${sucesso} | Falhas: ${falha}`
            );

            await wait(DELAY_BASE);
        }

        const last = members.last();
        after = last?.user?.id;
    }

    message.reply(
        `✅ Finalizado!\nEnviadas: ${sucesso}\nFalhas: ${falha}\nDM Fechada: ${dmsFechadas}`
    );
});

client.login(process.env.DISCORD_TOKEN);
