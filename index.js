require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ======= CONFIGURAÇÕES DE SEGURANÇA =======
const DELAY_BASE = 1500; // 1.5s por DM — seguro mesmo para 100k membros
const RETRY_LIMIT = 3;
const CHUNK_SIZE = 1000;
// ==========================================

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
    return new Promise(res => setTimeout(res, ms));
}

async function sendDM(member, payload) {
    for (let i = 1; i <= RETRY_LIMIT; i++) {
        try {
            await member.send(payload);
            return true;
        } catch (err) {
            console.log(`Falha DM (${member.user.tag}) tentativa ${i}`);
            await wait(2000 * i);
        }
    }
    return false;
}

// Extrai IDs no formato -{123} ou +{123}
function parseUserSelectors(text) {
    const ignore = new Set();
    const only = new Set();

    const regex = /([+-])\{(\d{5,30})\}/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const type = match[1];
        const id = match[2];

        if (type === "-") ignore.add(id);
        if (type === "+") only.add(id);
    }

    // Remove seletores do texto da mensagem
    const cleaned = text.replace(regex, "").trim();

    return { cleaned, ignore, only };
}

client.on("messageCreate", async (message) => {

    if (!message.content.startsWith("!announce") && 
        !message.content.startsWith("!announcefor")) return;

    if (message.author.bot) return;
    const command = message.content.startsWith("!announcefor") ? "for" : "announce";

    // Mensagem original
    const rawText = message.content
        .replace("!announcefor", "")
        .replace("!announce", "")
        .trim();

    // Extração de -{id} e +{id}
    const { cleaned, ignore, only } = parseUserSelectors(rawText);

    // Anexos
    const attachments = [];
    if (message.attachments.size > 0) {
        for (const att of message.attachments.values()) {
            attachments.push(att.url);
        }
    }

    if (!cleaned && attachments.length === 0) {
        return message.reply("Use: `!announce texto -{id}` ou `!announcefor texto +{id}`");
    }

    const guild = message.guild;
    if (!guild) return message.reply("Comando só pode ser usado dentro de um servidor.");

    message.reply("📢 Iniciando envio... isso pode levar um tempo.");

    let sucesso = 0;
    let falha = 0;
    let after = undefined;

    console.log("Iniciando paginação e envio...");

    while (true) {
        const members = await guild.members.list({
            limit: CHUNK_SIZE,
            after: after
        });

        if (members.size === 0) break;

        for (const member of members.values()) {
            if (member.user.bot) continue;

            const userId = member.user.id;

            // ====== FILTRAGEM DE USUÁRIOS ======

            // Modo "!announce" = envia para todos EXCETO ignorados
            if (command === "announce") {
                if (ignore.has(userId)) {
                    console.log(`Ignorado -${userId}`);
                    continue;
                }
            }

            // Modo "!announcefor" = envia SOMENTE para IDs positivos
            if (command === "for") {
                if (!only.has(userId)) {
                    continue;
                }
            }

            // ===================================

            const payload = {};
            if (cleaned) payload.content = cleaned;
            if (attachments.length > 0) payload.files = attachments;

            const ok = await sendDM(member, payload);

            if (ok) sucesso++;
            else falha++;

            console.log(`DM → ${member.user.tag} | OK: ${sucesso} | Falhas: ${falha}`);

            await wait(DELAY_BASE);
        }

        const last = members.last();
        after = last.user.id;
    }

    message.reply(`✅ Finalizado!\nDMs enviadas: ${sucesso}\nFalhas: ${falha}`);
});

client.login(process.env.DISCORD_TOKEN);
