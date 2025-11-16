/**
 * Announce Bot - Secure Opt-in DM version
 *
 * Safety-first:
 *  - Only sends DMs to users who explicitly opt-in (!subscribe)
 *  - Admin-only announce to subscribers via !announce_subscribers
 *  - Channel announcement command available (!announce_channel)
 *  - Persist subscribers & progress to disk (JSON)
 *  - Conservative adaptive rate limiter (start 1200ms)
 *
 * Requirements:
 *  - Node 18+
 *  - discord.js v14
 *  - .env with DISCORD_TOKEN in your deployment (Railway env vars recommended)
 *  - Enable in Developer Portal: Server Members Intent & Message Content Intent
 *
 * Commands:
 *  - !subscribe            -> opt in to receive DMs from this bot
 *  - !unsubscribe          -> opt out
 *  - !subs_count           -> check how many subs exist (public)
 *  - !announce_subscribers <message> [attach files] -> admin-only, sends to subscribers (DMs)
 *  - !announce_channel <message> [attach files] -> admin-only, posts in channel
 *  - !status               -> admin-only, shows current stats
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require("discord.js");

// ---------- CONFIG ----------
const SUB_FILE = path.resolve(__dirname, "subscribers.json"); // persisted list of subscribed user IDs
const PROG_FILE = path.resolve(__dirname, "announce_progress.json"); // progress when sending to subs
const SAVE_INTERVAL_MS = 10000; // periodic save interval to minimize IO

// Rate-limit conservative defaults
const GLOBAL_INITIAL_DELAY = 1200; // ms start
const GLOBAL_MIN = 800; // won't go below
const GLOBAL_MAX = 5000; // won't go above

const RETRY_ON_ERROR = 1; // how many extra attempts on transient errors
// ----------------------------

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

// In-memory state
let subscribers = new Set();
let progress = null; // { queued: [ids], sent: number, failed: number } when running an announce
let sendingRun = false;
let globalDelay = GLOBAL_INITIAL_DELAY;
let lastSendTs = 0;
let limiterLocked = false;
let saveTimer = null;

// Helpers: persist/load
function loadJSON(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Erro lendo ${file}:`, err);
    return defaultValue;
  }
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(file + ".tmp", file);
  } catch (err) {
    console.warn("Erro salvando", file, err);
  }
}

// Initialize persisted subscribers
(function initPersist() {
  const s = loadJSON(SUB_FILE, null);
  if (s && Array.isArray(s)) {
    subscribers = new Set(s);
    console.log(`Carregado ${subscribers.size} subscribers.`);
  } else {
    subscribers = new Set();
  }
  progress = loadJSON(PROG_FILE, null); // maybe null or previous progress
})();

// Periodic save of subscribers and progress
saveTimer = setInterval(() => {
  saveJSON(SUB_FILE, Array.from(subscribers));
  if (progress) saveJSON(PROG_FILE, progress);
}, SAVE_INTERVAL_MS);

// Graceful shutdown saving
process.on("exit", () => {
  saveJSON(SUB_FILE, Array.from(subscribers));
  if (progress) saveJSON(PROG_FILE, progress);
});
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

// Utility small wait
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Limiter: acquire slot ensures spacing at least globalDelay and serializes sends
async function acquireSendSlot() {
  while (true) {
    const now = Date.now();
    const elapsed = now - lastSendTs;
    if (!limiterLocked && elapsed >= globalDelay) {
      limiterLocked = true;
      return;
    }
    await wait(50);
  }
}
function releaseSendSlot() {
  lastSendTs = Date.now();
  limiterLocked = false;
}
function onSendSuccess() {
  // slightly reduce delay on success, but keep above min
  globalDelay = Math.max(GLOBAL_MIN, Math.round(globalDelay * 0.98));
}
function onRateLimit() {
  globalDelay = Math.min(GLOBAL_MAX, Math.round(globalDelay * 1.4));
}

// Send DM with safe retries and classification
async function safeSendDM(user, payload) {
  // user is a User object or a Member.user
  if (!user) return { ok: false, reason: "no_user" };

  // quick skip if user blocked in the past (we don't store blocks across runs here to preserve privacy)
  for (let attempt = 0; attempt <= RETRY_ON_ERROR; attempt++) {
    try {
      await acquireSendSlot();
      await user.send(payload);
      releaseSendSlot();
      onSendSuccess();
      return { ok: true };
    } catch (err) {
      // free the lock if held
      if (limiterLocked) {
        limiterLocked = false;
        lastSendTs = Date.now();
      }

      // classify
      const status = err?.status ?? err?.code ?? err?.statusCode ?? null;
      // DM closed or cannot message user
      if (status === 50007 || status === 403 || status === 50013) {
        // don't retry
        return { ok: false, reason: "dm_closed" };
      }
      // rate limit
      if (status === 429) {
        console.warn("⚠️ Rate limited (429). Backing off.");
        onRateLimit();
        await wait(globalDelay);
        continue; // retry
      }
      // transient network or other -> brief backoff, then retry if attempts left
      console.warn("Erro ao enviar DM:", err?.message ?? err, "retry:", attempt);
      await wait(600 * (attempt + 1));
    }
  }
  return { ok: false, reason: "failed" };
}

// ------------ Command handlers ------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const content = msg.content?.trim();
  if (!content) return;

  const isAdmin = msg.member?.permissions?.has(PermissionFlagsBits.Administrator);

  // -- subscribe
  if (content === "!subscribe") {
    const uid = msg.author.id;
    if (subscribers.has(uid)) {
      return msg.reply("Você já está inscrito para receber anúncios por DM.");
    }
    subscribers.add(uid);
    saveJSON(SUB_FILE, Array.from(subscribers));
    return msg.reply("Obrigado — você foi inscrito com sucesso. Você poderá receber anúncios por DM.");
  }

  // -- unsubscribe
  if (content === "!unsubscribe") {
    const uid = msg.author.id;
    if (!subscribers.has(uid)) {
      return msg.reply("Você não está inscrito.");
    }
    subscribers.delete(uid);
    saveJSON(SUB_FILE, Array.from(subscribers));
    return msg.reply("Você foi removido da lista de inscritos. Não receberá mais DMs.");
  }

  // -- subs count
  if (content === "!subs_count") {
    return msg.reply(`Número de inscritos (opt-in): ${subscribers.size}`);
  }

  // -- status (admin only)
  if (content === "!status") {
    if (!isAdmin) return msg.reply("Apenas administradores podem usar esse comando.");
    const p = progress ? `progress queued=${progress.queued?.length||0} sent=${progress.sent||0} failed=${progress.failed||0}` : "nenhuma execução em andamento";
    return msg.reply(`Status:\nSubscribers: ${subscribers.size}\nRate delay: ${globalDelay}ms\n${p}`);
  }

  // -- announce in channel (admin)
  if (content.startsWith("!announce_channel")) {
    if (!isAdmin) return msg.reply("Apenas administradores podem usar este comando.");
    const messageText = content.replace("!announce_channel", "").trim();
    if (!messageText && msg.attachments.size === 0) return msg.reply("Use: `!announce_channel <mensagem>` e opcionalmente anexe arquivos.");
    // build payload for channel
    const payload = {};
    if (messageText) payload.content = messageText;
    if (msg.attachments.size > 0) {
      payload.files = [...msg.attachments.values()].map(a => a.url);
    }
    try {
      await msg.channel.send(payload);
      return msg.reply("✅ Mensagem enviada no canal.");
    } catch (err) {
      console.error("Erro enviando no canal:", err);
      return msg.reply("❌ Falha ao enviar no canal. Verifique permissões e logs.");
    }
  }

  // -- announce to subscribers (admin)
  if (content.startsWith("!announce_subscribers")) {
    if (!isAdmin) return msg.reply("Apenas administradores podem usar este comando.");
    if (sendingRun) return msg.reply("Já existe um envio em andamento. Aguarde terminar ou verifique `!status`.");
    const body = content.replace("!announce_subscribers", "").trim();
    if (!body && msg.attachments.size === 0) return msg.reply("Use: `!announce_subscribers <mensagem>` e opcionalmente anexe arquivos. Só enviaremos para inscritos (opt-in).");

    // gather payload and queued subscriber IDs
    const attachUrls = msg.attachments.size > 0 ? [...msg.attachments.values()].map(a => a.url) : [];
    const msgPayload = {};
    if (body) msgPayload.content = body;
    if (attachUrls.length) msgPayload.files = attachUrls;

    // Build list of subscribers that are still in this guild (optionally: only members of this guild)
    // For maximum safety, we'll only DM subscribers who are members of the server where the command was issued.
    const guild = msg.guild;
    if (!guild) return msg.reply("Comando deve ser usado dentro do servidor para garantir que o anúncio seja restrito ao contexto do servidor.");

    // Prepare queue: check membership and member.fetch for valid DM user object
    const queued = [];
    for (const uid of subscribers) {
      try {
        const member = await guild.members.fetch(uid).catch(() => null);
        if (!member) continue; // subscriber not in this guild or cannot be fetched
        queued.push({ id: uid, user: member.user }); // store User object for quick send
      } catch (err) { continue; }
    }

    if (queued.length === 0) {
      return msg.reply("Nenhum inscrito (opt-in) válido encontrado neste servidor para enviar DMs.");
    }

    // Confirm and start
    msg.reply(`⚠️ Este comando enviará DMs para ${queued.length} inscritos deste servidor. Iniciando em breve...`);

    // Initialize progress object for persistence
    progress = {
      mode: "subscribers",
      guildId: guild.id,
      payload: msgPayload,
      queued: queued.map(q => q.id),
      nextIndex: 0,
      sent: 0,
      failed: 0,
      timestampStart: Date.now()
    };
    saveJSON(PROG_FILE, progress);

    // Start sending loop (single-threaded to minimize resource/abuse)
    sendingRun = true;
    (async () => {
      try {
        for (let i = progress.nextIndex; i < progress.queued.length; i++) {
          const uid = progress.queued[i];
          // Avoid heavy CPU: yield occasionally
          if (i % 50 === 0) await wait(20);

          // build user object
          const member = await guild.members.fetch(uid).catch(() => null);
          if (!member) {
            progress.failed++;
            progress.nextIndex = i + 1;
            saveJSON(PROG_FILE, progress);
            continue;
          }

          const res = await safeSendDM(member.user, msgPayload);
          if (res.ok) progress.sent++;
          else {
            if (res.reason === "dm_closed") {
              // don't count as failed, but skip
            } else {
              progress.failed++;
            }
          }
          progress.nextIndex = i + 1;

          // persist every N
          if (progress.nextIndex % 20 === 0) saveJSON(PROG_FILE, progress);
        }
      } catch (err) {
        console.error("Erro durante envio de subscribers:", err);
      } finally {
        saveJSON(PROG_FILE, progress);
        sendingRun = false;
        // keep progress file so you can inspect, but we remove when done
        // On completion, delete progress to indicate finished run
        try { fs.unlinkSync(PROG_FILE); } catch {}
        msg.reply(`✅ Envio finalizado. Enviadas: ${progress.sent} | Falhas: ${progress.failed}`);
        progress = null;
      }
    })();

    return;
  }

  // -- fallback: ignore
});

// On startup, log basic info
client.on("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
  console.log(`Subscribers: ${subscribers.size}`);
  // if progress file exists, log that a saved run can be resumed by an admin re-issuing announce_subscribers (or auto-resume later)
  if (progress && progress.queued && progress.queued.length > 0) {
    console.log("Encontrado progress salvo: possível envio interrompido. Admins podem usar !status para ver.");
  }
});

// login
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("Erro ao logar:", err);
  process.exit(1);
});
