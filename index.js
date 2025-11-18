require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require("discord.js");

// ===== CONFIG =====
const WORKERS = 1; 
const RETRY_LIMIT = 3;
const STATE_FILE = path.resolve(__dirname, "state.json");
const PROGRESS_UPDATE_INTERVAL = 5000;

// === CONFIGURAÇÕES DE SEGURANÇA (ANTI-QUARENTENA) ===
const DELAY_BASE_MS = 10000; 
const DELAY_RANDOM_MS = 10000; 
const BATCH_SIZE = 25; 
const MIN_BATCH_PAUSE_MS = 1 * 60 * 1000; // 1 minuto
const MAX_BATCH_PAUSE_MS = 5 * 60 * 1000; // 5 minutos

// === CONFIG DE SEGURANÇA ANTIS-SPAM (COOLDOWN DINÂMICO POR GUILD) ===
const GUILD_COOLDOWN_MIN_HOURS = 6; 
const GUILD_COOLDOWN_MIN_MS = GUILD_COOLDOWN_MIN_HOURS * 3600000;
const COOLDOWN_PENALTY_MS_PER_USER = 1000; 
// ===================

// === State persistence ===
function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        const s = JSON.parse(raw);
        // Garante que processedMembers seja um Set ao carregar
        if (s.guildData) {
            for (const guildId in s.guildData) {
                if (s.guildData[guildId].processedMembers) {
                    s.guildData[guildId].processedMembers = new Set(s.guildData[guildId].processedMembers);
                } else {
                    s.guildData[guildId].processedMembers = new Set();
                }
            }
        }

        return Object.assign({
            active: false,
            text: "",
            attachments: [],
            ignore: [],
            only: [],
            queue: [], 
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            mode: "announce",
            quarantine: false,
            currentAnnounceGuildId: null,
            guildData: {} 
        }, s);
    } catch {
        return {
            active: false,
            text: "",
            attachments: [],
            ignore: [],
            only: [],
            queue: [],
            currentRunStats: { success: 0, fail: 0, closed: 0 },
            progressMessageRef: null,
            mode: "announce",
            quarantine: false,
            currentAnnounceGuildId: null,
            guildData: {}
        };
    }
}

function saveState(s) {
    try {
        // --- 1. Prepara guildData para serialização (Set para Array) ---
        const serializableGuildData = JSON.parse(JSON.stringify(s.guildData));
        for (const guildId in serializableGuildData) {
            if (s.guildData[guildId].processedMembers instanceof Set) {
                // Converte Set para Array para salvar no JSON
                serializableGuildData[guildId].processedMembers = [...s.guildData[guildId].processedMembers];
            }
        }
        
        // --- 2. Persiste a Fila ATIVA (s.queue) no pendingQueue da Guild se estiver ativo ---
        if (s.active && s.currentAnnounceGuildId) {
            const currentGuildId = s.currentAnnounceGuildId;
            serializableGuildData[currentGuildId] = serializableGuildData[currentGuildId] || {};
            
            // A fila global ATUAL é a fila de pendentes no momento do salvamento.
            serializableGuildData[currentGuildId].pendingQueue = s.queue;
            
            // Criamos uma cópia do estado onde a fila global é esvaziada.
            const copy = JSON.parse(JSON.stringify(s)); // Deep copy
            copy.queue = []; // Garante que a cópia salva está sem a fila global
            copy.guildData = serializableGuildData;
            
            fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));

        } else {
            // Salva o estado normal
            const copy = {
                active: !!s.active,
                currentAnnounceGuildId: s.currentAnnounceGuildId || null,
                text: s.text || "",
                attachments: Array.isArray(s.attachments) ? s.attachments : [],
                ignore: Array.isArray(s.ignore) ? s.ignore : [],
                only: Array.isArray(s.only) ? s.only : [],
                queue: Array.isArray(s.queue) ? s.queue : [],
                currentRunStats: s.currentRunStats || { success: 0, fail: 0, closed: 0 },
                progressMessageRef: (s.progressMessageRef && s.progressMessageRef.channelId && s.progressMessageRef.messageId) ? s.progressMessageRef : null,
                mode: s.mode || "announce",
                quarantine: !!s.quarantine,
                guildData: serializableGuildData // Usa os dados serializáveis
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));
        }
    } catch (e) {
        console.error("Erro ao salvar state:", e);
    }
}

function modifyStateAndSave(callback) {
    callback(state);
    saveState(state);
}

let state = loadState();

// === Discord client ===
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

// runtime refs (not persisted)
let progressMessageRuntime = null;
let progressUpdaterHandle = null;
let workerRunning = false;

// === utils ===
const wait = ms => new Promise(res => setTimeout(res, ms));

function parseSelectors(text) {
    const ignore = new Set();
    const only = new Set();
    const regex = /([+-])\{(\d{5,30})\}/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
        if (m[1] === '-') ignore.add(m[2]);
        if (m[1] === '+') only.add(m[2]);
    }
    const cleanedText = text.replace(regex, "").trim();
    // Remove o marcador 'force' se existir
    const finalCleaned = cleanedText.toLowerCase().includes('force') 
                         ? cleanedText.replace(/force/i, '').trim()
                         : cleanedText;
                         
    return { cleaned: finalCleaned, ignore, only, hasForce: cleanedText.toLowerCase().includes('force') };
}

// Garante que cada DM tenha um hash ligeiramente diferente
function getVariedText(baseText) {
    if (!baseText || baseText.length === 0) return "";
    const zeroWidthSpace = "\u200B";
    const randomSuffix = Array(Math.floor(Math.random() * 3) + 1).fill(zeroWidthSpace).join('');
    return randomSuffix + baseText;
}

// send DM with retry/backoff and quarantine detection
async function sendDMToMember(memberOrUser, payload) {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        try {
            await memberOrUser.send(payload);
            return { success: true };
        } catch (err) {
            const errString = String(err?.message || err);

            if (err?.code === 50007) {
                console.log(`DM closed for ${memberOrUser.id}.`);
                return { success: false, reason: "closed" };
            }

            if (errString.includes("app-quarantine") || errString.includes("flagged by our anti-spam system")) {
                console.error(`QUARANTINE DETECTED for app. Stopping all sends.`);
                modifyStateAndSave(s => s.quarantine = true);
                return { success: false, reason: "quarantine" };
            }

            const retryAfter = err?.retry_after || err?.retryAfter;
            if (retryAfter) {
                const waitMs = Number(retryAfter) * 1000 + 1500;
                console.warn(`RATE LIMITED (retry_after). Waiting ${waitMs}ms. Attempt ${attempt}/${RETRY_LIMIT}`);
                await wait(waitMs);
                continue;
            }

            if (err?.status === 429 || err?.statusCode === 429) {
                const backoffMs = (5000 * attempt) + Math.floor(Math.random() * 2000); 
                console.warn(`RATE LIMITED (429). Waiting (429) ${backoffMs}ms. Attempt ${attempt}/${RETRY_LIMIT}`);
                await wait(backoffMs);
                continue;
            }

            // Other errors
            const backoffMs = 1500 * attempt;
            console.error(`Failed to send DM to ${memberOrUser.id} (Attempt ${attempt}/${RETRY_LIMIT}): ${errString}. Retrying in ${backoffMs}ms.`);
            await wait(backoffMs);
        }
    }
    console.error(`Failed to send DM to ${memberOrUser.id} after ${RETRY_LIMIT} attempts.`);
    return { success: false, reason: "fail" };
}

// === Progress embed utils ===
async function updateProgressEmbed() {
    if (!state.progressMessageRef) return;
    
    let msg = progressMessageRuntime;
    if (!msg) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (!ch || !ch.isTextBased()) return;
            msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
            progressMessageRuntime = msg;
        } catch (e) {
            return;
        }
    }
    if (!msg) return;

    try {
        const guildData = state.guildData[state.currentAnnounceGuildId] || {};
        
        // Se o envio está ativo, a fila real é state.queue.
        // Se foi interrompido, a fila é pendingQueue + failedQueue.
        let queueLength = state.queue.length;
        if (!state.active) {
             queueLength = (guildData.pendingQueue?.length || 0) + (guildData.failedQueue?.length || 0);
        }
        
        const embed = new EmbedBuilder()
            .setTitle("📨 Envio em progresso")
            .setColor("#00AEEF")
            .addFields(
                { name: "Enviadas", value: `${state.currentRunStats.success}`, inline: true },
                { name: "Falhas", value: `${state.currentRunStats.fail}`, inline: true },
                { name: "DM Fechada", value: `${state.currentRunStats.closed}`, inline: true },
                { name: "Restando na Fila", value: `${queueLength}`, inline: true }
            )
            .setTimestamp();
        await msg.edit({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        // Erros de edição (ex: mensagem foi apagada)
    }
}

function startProgressUpdater() {
    if (progressUpdaterHandle) return;
    progressUpdaterHandle = setInterval(() => {
        if (!state.active) return;
        updateProgressEmbed();
    }, PROGRESS_UPDATE_INTERVAL);
}

function stopProgressUpdater() {
    if (progressUpdaterHandle) {
        clearInterval(progressUpdaterHandle);
        progressUpdaterHandle = null;
    }
}

// === Worker (single) ===
async function workerLoop() {
    console.log("Worker iniciado.");
    const currentGuildId = state.currentAnnounceGuildId;
    const guildData = state.guildData[currentGuildId];

    try {
        let messagesSentInBatch = 0;
        
        while (state.active && state.queue && state.queue.length > 0) {
            
            // --- Pausa de Lote Lógica ---
            if (messagesSentInBatch >= BATCH_SIZE) {
                // Cálculo da Pausa Variável (1 a 5 minutos)
                const rangeMs = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS; 
                const pauseDurationMs = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * rangeMs); 
                const pauseDurationMinutes = (pauseDurationMs / 60000).toFixed(1);

                console.log(`PAUSA DE LOTE: ${messagesSentInBatch} DMs enviadas. Pausando por ${pauseDurationMinutes} minutos.`);
                
                // SALVAMENTO CRÍTICO: Persiste o estado da fila (s.queue) antes da longa pausa.
                saveState(state); 
                
                await updateProgressEmbed();
                await wait(pauseDurationMs); 
                
                messagesSentInBatch = 0;
                console.log("Retomando envio após a pausa.");
                
                // O estado pode ter mudado durante a longa espera (ex: !stop)
                if (!state.active || state.queue.length === 0) break; 
            }
            // --- Fim Pausa de Lote Lógica ---

            // Pega o ID a ser processado
            const userId = state.queue[0];
            
            // SALVAMENTO CRÍTICO: Salva o estado ANTES de remover o ID (para o auto-resume)
            saveState(state); 
            
            // Remove o ID da fila global
            modifyStateAndSave(s => s.queue.shift());

            let user = client.users.cache.get(userId);
            if (!user) {
                try {
                    user = await client.users.fetch(userId).catch(() => null);
                } catch {
                    user = null;
                }
            }
            
            if (!user || user.bot) {
                continue;
            }

            let imageOk = true;
            let textOk = true;

            // Função auxiliar para registrar falha na fila específica da guild
            const registerFailure = (reason) => {
                modifyStateAndSave(s => {
                    if (reason === "closed") {
                        s.currentRunStats.closed++;
                    } else {
                        s.currentRunStats.fail++;
                    }
                    s.guildData[currentGuildId].failedQueue = s.guildData[currentGuildId].failedQueue || [];
                    s.guildData[currentGuildId].failedQueue.push(userId); 
                });
            };
            
            // 1. Envio de ANEXOS (Se existirem)
            if (state.attachments && state.attachments.length > 0) {
                const imgPayload = { files: state.attachments };
                const result = await sendDMToMember(user, imgPayload);

                if (!result.success) {
                    imageOk = false;
                    if (result.reason === "quarantine") {
                        console.error("Quarentena detectada; parando worker.");
                        modifyStateAndSave(s => s.active = false); // Garante a saída
                        break; 
                    } else {
                        registerFailure(result.reason);
                    }
                    await wait(DELAY_BASE_MS + Math.floor(Math.random() * DELAY_RANDOM_MS));
                    continue;
                }
            }

            // 2. Envio de TEXTO (Se existir e o envio de anexo não falhou de forma terminal)
            if (state.text) {
                let contentToSend = state.text;
                
                if (!contentToSend.includes("http")) {
                    contentToSend = getVariedText(contentToSend);
                }
                
                const textPayload = { content: contentToSend };
                const result = await sendDMToMember(user, textPayload);

                if (!result.success) {
                    textOk = false;
                    if (result.reason === "quarentena") {
                        console.error("Quarentena detectada; parando worker.");
                        modifyStateAndSave(s => s.active = false); // Garante a saída
                        break; 
                    } else {
                        registerFailure(result.reason);
                    }
                }
            }

            const wasSuccess = imageOk && textOk;

            if (wasSuccess) {
                modifyStateAndSave(s => s.currentRunStats.success++);
                
                // Remove o ID da fila de falhas (se ele estava em um !resume)
                if (currentGuildId && guildData.failedQueue) {
                    const index = guildData.failedQueue.indexOf(userId);
                    if (index > -1) {
                        modifyStateAndSave(s => s.guildData[currentGuildId].failedQueue.splice(index, 1));
                    }
                }
            }

            updateProgressEmbed().catch(() => {});
            
            // Atraso normal entre mensagens
            await wait(DELAY_BASE_MS + Math.floor(Math.random() * DELAY_RANDOM_MS));
            messagesSentInBatch++;
        }
    } catch (err) {
        console.error("Erro no worker:", err);
    } finally {
        console.log("Worker finalizado.");
        workerRunning = false;
        await finalizeSending();
    }
}

function startWorkerSafe() {
    if (workerRunning) {
        console.log("Worker já rodando — ignorando start.");
        return;
    }
    workerRunning = true;
    workerLoop().catch(err => { console.error("Worker exception:", err); workerRunning = false; });
}

// === Finalize logic: send embed + maybe sent.txt ===
async function finalizeSending() {
    stopProgressUpdater();
    progressMessageRuntime = null;

    const currentAnnounceGuildId = state.currentAnnounceGuildId;
    const chRef = state.progressMessageRef;
    const { success, fail, closed } = state.currentRunStats;
    const totalSent = success + fail + closed;
    
    // O estado 'active' já foi definido como false pelo worker ou pelo !stop.
    
    // Verifica se restam falhas/pendentes. Como o state foi salvo com a fila no pendingQueue, 
    // verificamos o pendingQueue + failedQueue do guildData.
    const currentGuildData = state.guildData[currentAnnounceGuildId] || {};
    
    const pendingQueueSize = currentGuildData.pendingQueue?.length || 0;
    const remainingFails = currentGuildData.failedQueue?.length || 0;
    
    const totalRemaining = pendingQueueSize + remainingFails;
    const wasQueueEmpty = state.queue.length === 0 && totalRemaining === 0;

    const remainingText = totalRemaining > 0 ? `❗ Restam ${totalRemaining} membros. Use **!resume**.` : "✔️ Envio concluído.";

    const embed = new EmbedBuilder()
        .setTitle("📬 Envio Finalizado")
        .setColor(totalRemaining > 0 || state.quarantine ? 0xFF0000 : 0x00AEEF)
        .addFields(
            { name: "Enviadas (Sucesso Total)", value: `${success}`, inline: true },
            { name: "Falhas (API/Erro)", value: `${fail}`, inline: true },
            { name: "DM Fechada", value: `${closed}`, inline: true },
            { name: "Restando para Retomar", value: `${totalRemaining}`, inline: true }
        )
        .setFooter({ text: remainingText })
        .setTimestamp();
    
    if (state.quarantine) {
        embed.addFields({ name: "⚠️ QUARENTENA ATIVADA", value: "Seu bot foi marcado. Todos os envios foram interrompidos.", inline: false });
    }
    
    const content = totalRemaining > 0 ? remainingText : (state.quarantine ? "❗ Envio interrompido por quarentena." : "✔️ Envio concluído com sucesso.");

    try {
        if (chRef && chRef.channelId) {
            const ch = await client.channels.fetch(chRef.channelId).catch(() => null);
            if (ch && ch.isTextBased()) {
                const msg = await ch.messages.fetch(chRef.messageId).catch(() => null);
                if (msg) {
                    await msg.edit({ content, embeds: [embed], files: [] }).catch(async (e) => {
                        console.warn("Não foi possível editar mensagem de progresso, enviando novo resumo.", e);
                        await ch.send({ content, embeds: [embed], files: [] }).catch(() => {});
                    });
                } else {
                    await ch.send({ content, embeds: [embed], files: [] }).catch(() => {});
                }
            } else {
                console.warn("Canal de progresso não disponível para postar resumo final.");
            }
        } else {
            console.warn("Sem referência de progresso para postar resumo final.");
        }
    } catch (e) {
        console.error("Erro ao publicar resumo final:", e);
    } finally {
        // === Lógica de Cooldown e Limpeza Final ===
        
        if (currentAnnounceGuildId && !state.quarantine && wasQueueEmpty && totalSent > 0) {
            // Envio 100% concluído (fila estava vazia e não houve !stop/queda com pendentes)
            modifyStateAndSave(s => {
                s.guildData[currentAnnounceGuildId] = s.guildData[currentAnnounceGuildId] || {};
                s.guildData[currentAnnounceGuildId].lastAnnounceTime = Date.now();
                s.guildData[currentAnnounceGuildId].totalSuccess = success;
                s.guildData[currentAnnounceGuildId].totalFail = fail;
                s.guildData[currentAnnounceGuildId].totalClosed = closed;
                // Limpa processedMembers, pois a campanha acabou
                s.guildData[currentAnnounceGuildId].processedMembers = new Set(); 
                s.active = false;
                s.currentAnnounceGuildId = null;
                // Limpa filas de resume, pois o envio acabou.
                s.guildData[currentAnnounceGuildId].failedQueue = [];
                s.guildData[currentAnnounceGuildId].pendingQueue = [];
            });
        } else {
            // Envio foi interrompido (quarentena, !stop ou queda, ou terminou com falhas/pendentes).
            // O estado de active/currentAnnounceGuildId já foi limpo, mas precisamos garantir que a fila global está vazia.
            modifyStateAndSave(s => {
                s.active = false;
                s.currentAnnounceGuildId = null;
                s.queue = [];
            });
        }
    }
}

// === Commands and flow ===
client.on("messageCreate", async (message) => {
    try {
        if (message.author.bot || !message.guild) return;
        
        const guildId = message.guild.id;
        const command = message.content.toLowerCase().split(' ')[0];
        const isAnnounceCommand = command.startsWith("!announce") || command.startsWith("!announcefor");
        const isResumeCommand = command === "!resume";
        const isStopCommand = command === "!stop";
        const isUpdateCommand = command === "!update";

        if (!isAnnounceCommand && !isResumeCommand && !isStopCommand && !isUpdateCommand) return;
        
        // Permite que apenas o dono do servidor use os comandos críticos
        if (message.author.id !== message.guild.ownerId) {
             return message.reply("⛔ Apenas o dono do servidor pode usar comandos de anúncio/gestão de fila.");
        }

        // Inicializa dados da guild se necessário (incluindo Set para processedMembers)
        if (!state.guildData[guildId] || !(state.guildData[guildId].processedMembers instanceof Set)) {
            modifyStateAndSave(s => s.guildData[guildId] = { 
                lastAnnounceTime: 0, totalSuccess: 0, totalFail: 0, totalClosed: 0, 
                failedQueue: [], pendingQueue: [], lastRunText: "", lastRunAttachments: [],
                processedMembers: new Set() 
            });
        }
        const guildSpecificData = state.guildData[guildId];


        // Lógica de !STOP
        if (isStopCommand) {
            if (!state.active || state.currentAnnounceGuildId !== guildId) {
                return message.reply("⚠️ Não há envio ativo neste servidor para ser parado.");
            }
            // Apenas desativa e salva. O workerLoop fará a limpeza e finalização.
            modifyStateAndSave(s => s.active = false); 
            return message.reply("⏸️ Envio interrompido. Os membros restantes foram salvos. Use `!resume` para continuar a partir de onde parou.");
        }
        
        // Lógica de !UPDATE (Permitido durante ou após o envio)
        if (isUpdateCommand) {
            
            // 1. Verifica se existe uma campanha anterior para retomar/atualizar
            if (!guildSpecificData.lastRunText && guildSpecificData.lastRunAttachments.length === 0) {
                 return message.reply("❌ Nenhuma campanha anterior encontrada neste servidor para atualizar. Use `!announce` primeiro.");
            }

            // 2. Determina o alvo da adição (Fila Ativa ou Fila Pendente)
            const isCampaignActive = state.active && state.currentAnnounceGuildId === guildId;
            
            await message.guild.members.fetch().catch(() => {});
            
            // 3. Obtém membros já processados/alvejados
            const processedMembers = guildSpecificData.processedMembers;
            
            let membersAdded = 0;
            const newMembers = [];
            
            message.guild.members.cache.forEach(m => {
                if (!m || m.user.bot) return;
                
                // Se o membro ainda NÃO está no Set de membros que já foram alvejados por esta campanha
                if (!processedMembers.has(m.id)) {
                    newMembers.push(m.id);
                    membersAdded++;
                }
            });

            if (membersAdded === 0) {
                return message.reply("✅ Nenhum novo membro para adicionar à fila.");
            }
            
            // 4. Adiciona novos membros ao alvo e atualiza processedMembers
            modifyStateAndSave(s => {
                if (isCampaignActive) {
                    // Adiciona à fila ativa GLOBAL
                    s.queue.push(...newMembers);
                } else {
                    // Adiciona à fila pendente (para ser pego por !resume)
                    s.guildData[guildId].pendingQueue = s.guildData[guildId].pendingQueue || [];
                    s.guildData[guildId].pendingQueue.push(...newMembers);
                }
                
                // Atualiza o set de membros processados para não adicioná-los novamente
                newMembers.forEach(id => s.guildData[guildId].processedMembers.add(id));
            });

            const statusMsg = isCampaignActive 
                ? `foi adicionado(s) ao **final da fila de envio ativa**. Restam agora ${state.queue.length} membros.`
                : `foi adicionado(s) à **fila pendente**. Use \`!resume\` para iniciar o envio.`;

            return message.reply(`➕ **${membersAdded}** novo(s) membro(s) ${statusMsg}`);
        }


        // 1. LÓGICA DO COOLDOWN E CONFIRMAÇÃO (!announce/!announcefor)
        if (isAnnounceCommand) {
            
            // 1.1. Verifica se já existe um envio globalmente (segurança primária)
            if (state.active) {
                return message.reply("❗ Já existe um envio em andamento **GLOBALMENTE**. Aguarde a conclusão da tarefa atual ou use `!stop`.");
            }

            // 1.2. Verifica a necessidade de confirmação (pending/failed queue)
            const failedQueue = guildSpecificData.failedQueue || [];
            const pendingQueue = guildSpecificData.pendingQueue || [];
            const totalRemaining = failedQueue.length + pendingQueue.length;
            
            let parsed = parseSelectors(message.content.replace(command, "").trim());
            
            // Se houver filas pendentes E o usuário NÃO usou o comando 'force'
            if (totalRemaining > 0 && !parsed.hasForce) {
                 const forceCommand = command.endsWith('for') ? `!announcefor force ${parsed.cleaned}` : `!announce force ${parsed.cleaned}`;
                 
                 const resumeCount = pendingQueue.length > 0 ? `${pendingQueue.length} pendente(s)` : '';
                 const failedCount = failedQueue.length > 0 ? `${failedQueue.length} falha(s)` : '';
                 const separator = resumeCount && failedCount ? ' e ' : '';
                 const pendingInfo = `${resumeCount}${separator}${failedCount}`;
                 
                 return message.reply(`
                    ⚠️ **Atenção!** Há um envio anterior com **${totalRemaining}** membros (${pendingInfo}) para retomar.
                    
                    * Para **continuar** de onde parou, use: **\`!resume\`**
                    * Para **descartar** essa fila e iniciar uma **nova** campanha, use: **\`${forceCommand}\`**
                 `);
            }
            
            // 1.3. Lógica do Cooldown (continua apenas se não houver pendentes OU se 'force' foi usado)
            const now = Date.now();
            const timeSinceLastAnnounce = now - guildSpecificData.lastAnnounceTime;
            const lastCampaignSize = guildSpecificData.totalSuccess + guildSpecificData.totalClosed + guildSpecificData.totalFail;
            
            let requiredCooldownMs = GUILD_COOLDOWN_MIN_MS;
            if (lastCampaignSize > 0) {
                requiredCooldownMs = Math.max(
                    GUILD_COOLDOWN_MIN_MS, 
                    lastCampaignSize * COOLDOWN_PENALTY_MS_PER_USER
                );
            }

            if (guildSpecificData.lastAnnounceTime !== 0 && timeSinceLastAnnounce < requiredCooldownMs) {
                const remainingTimeMs = requiredCooldownMs - timeSinceLastAnnounce;
                const remainingHours = Math.floor(remainingTimeMs / 3600000);
                const remainingMinutes = Math.ceil((remainingTimeMs % 3600000) / 60000);
                
                let remainingDisplay = "";
                if (remainingHours > 0) remainingDisplay += `${remainingHours} horas`;
                if (remainingMinutes > 0) {
                    if (remainingDisplay) remainingDisplay += ` e `;
                    remainingDisplay += `${remainingMinutes} minutos`;
                }

                const penaltyDurationHours = (requiredCooldownMs / 3600000).toFixed(1);
                
                return message.reply(`⛔ Cooldown Ativo. O último envio de **${lastCampaignSize} DMs** exige um descanso de **${penaltyDurationHours} horas** (anti-spam). Restam **${remainingDisplay}**.`);
            }
            
            // Se 'force' foi usado, limpa as filas pendentes e falhas (sobrescrita confirmada)
            if (totalRemaining > 0 && parsed.hasForce) {
                 modifyStateAndSave(s => {
                    s.guildData[guildId].failedQueue = [];
                    s.guildData[guildId].pendingQueue = []; 
                 });
                 message.reply(`🗑️ Fila anterior de **${totalRemaining}** membros foi descartada. Iniciando nova campanha.`);
            }


        // 2. PREPARAÇÃO DA FILA (ANNOUNCE & RESUME)
        let queue = [];
        let textToUse = "";
        let attachmentsToUse = [];
        let mode = "announce";
        
        
        if (isResumeCommand) {
            // Verifica se já existe um envio globalmente (segurança primária)
            if (state.active) {
                return message.reply("❗ Já existe um envio em andamento **GLOBALMENTE**. Aguarde a conclusão da tarefa atual.");
            }
            
            // Junta a fila de falhas confirmadas e a fila de pendentes (interrompidos)
            const failedQueue = guildSpecificData.failedQueue || [];
            const pendingQueue = guildSpecificData.pendingQueue || [];
            
            // Concatena as duas filas e remove duplicatas
            const uniqueQueue = [...new Set([...pendingQueue, ...failedQueue])];
            
            if (uniqueQueue.length === 0) {
                return message.reply("✅ Nenhuma falha ou envio pendente para retomar neste servidor.");
            }
            
            textToUse = guildSpecificData.lastRunText || "";
            attachmentsToUse = guildSpecificData.lastRunAttachments || [];
            queue = uniqueQueue;
            mode = "announce"; 

            if (!textToUse && attachmentsToUse.length === 0) {
                return message.reply("❌ Não foi possível retomar: Dados da última mensagem (texto/anexos) não foram encontrados. Use `!announce` novamente.");
            }
            
            console.log(`Retomando envio para ${queue.length} usuários.`);
            
            // Ao retomar, movemos os IDs do pendingQueue/failedQueue para a fila ativa (state.queue)
            // e zeramos as filas de resume da guild.
            modifyStateAndSave(s => {
                s.guildData[guildId].failedQueue = [];
                s.guildData[guildId].pendingQueue = [];
                s.currentRunStats = { success: 0, fail: 0, closed: 0 }; // Reseta as estatísticas da run
            });


        } else if (isAnnounceCommand) {
            
            mode = message.content.startsWith("!announcefor") ? "for" : "announce";
            // O `parsed` já foi calculado acima, contendo o texto limpo (sem 'force')
            
            attachmentsToUse = [...message.attachments.values()].map(a => a.url);
            textToUse = parsed.cleaned;

            if (!textToUse && attachmentsToUse.length === 0) {
                 // Deve usar o texto limpo, que agora não contém 'force'
                return message.reply("O comando precisa de texto ou anexo. Use `!announce texto -{id}` ou `!announcefor texto +{id}`.");
            }

            const guild = message.guild;
            try { await guild.members.fetch(); } catch (e) { console.warn("guild.members.fetch() falhou (intents?). Continuando com cache."); }

            const initialProcessedMembers = new Set();
            
            guild.members.cache.forEach(m => {
                if (!m || !m.user || m.user.bot) return;
                
                // Aplica filtros
                if (mode === "announce" && parsed.ignore.has(m.id)) return;
                if (mode === "for" && !parsed.only.has(m.id)) return;
                
                queue.push(m.id);
                initialProcessedMembers.add(m.id);
            });
            
            if (queue.length === 0) {
                return message.reply("A fila de envio está vazia após aplicar os filtros.");
            }
            
            // ARMAZENA O CONTEÚDO ATUAL E POPULA processedMembers (Filas pendentes/falhas foram limpas pelo 'force' se necessário)
            modifyStateAndSave(s => {
                s.guildData[guildId].lastRunText = textToUse;
                s.guildData[guildId].lastRunAttachments = attachmentsToUse;
                s.guildData[guildId].processedMembers = initialProcessedMembers;
                s.currentRunStats = { success: 0, fail: 0, closed: 0 }; 
            });

        }

        if (queue.length === 0) return message.reply("A fila de envio está vazia.");

        // 3. INICIA O ESTADO DA EXECUÇÃO
        state = {
            active: true,
            currentAnnounceGuildId: guildId,
            text: textToUse,
            mode,
            attachments: attachmentsToUse,
            ignore: [...parsed.ignore],
            only: [...parsed.only],
            queue, // A fila global é populada para a execução
            currentRunStats: state.currentRunStats, // Mantém o estado atual, mas resetamos na preparação do resume/announce
            progressMessageRef: null,
            quarantine: state.quarantine, 
            guildData: state.guildData
        };
        saveState(state); // Salva o estado inicial

        const commandName = isResumeCommand ? "Retomando" : "Preparando";
        const progressMsg = await message.reply(`📢 **${commandName}** envio para **${queue.length}** membros...`);
        modifyStateAndSave(s => s.progressMessageRef = { channelId: progressMsg.channel.id, messageId: progressMsg.id });

        await wait(700);
        try { await progressMsg.edit("🔄 Envio iniciado em modo seguro (1 DM a cada 10s-20s)."); } catch (e) {}

        startProgressUpdater();
        startWorkerSafe();

    } catch (err) {
        console.error("Erro em messageCreate:", err);
        message.reply("❌ Ocorreu um erro interno ao iniciar o envio.");
    }
});

// === Ready / auto-resume ===
client.on("ready", async () => {
    console.log(`Bot online como ${client.user.tag}`);

    // Tenta recuperar a mensagem de progresso
    if (state.progressMessageRef && state.progressMessageRef.channelId && state.progressMessageRef.messageId) {
        try {
            const ch = await client.channels.fetch(state.progressMessageRef.channelId).catch(() => null);
            if (ch) {
                const msg = await ch.messages.fetch(state.progressMessageRef.messageId).catch(() => null);
                if (msg) progressMessageRuntime = msg;
            }
        } catch (e) { /* ignore */ }
    }

    // Lógica de auto-resume robusta
    if (state.active && state.currentAnnounceGuildId) {
        const currentGuildId = state.currentAnnounceGuildId;
        const guildData = state.guildData[currentGuildId];
        
        // Verifica se há IDs pendentes para a execução em curso (que foram salvos no pendingQueue antes do build)
        if (guildData?.pendingQueue?.length > 0) {
            // Recarrega pendingQueue para a fila ativa (state.queue)
            state.queue = guildData.pendingQueue;
            console.log(`Auto-resume: Recarregada a fila de ${state.queue.length} IDs pendentes para a guild ${currentGuildId}.`);
            
            // Limpa a pendingQueue após mover, para evitar duplicação no próximo save
            guildData.pendingQueue = [];
            // Salva o estado para persistir a pendingQueue vazia e a fila no state.queue para o worker
            saveState(state); 
        }
    }
    
    // Inicia o worker se houver uma fila ativa
    if (state.active && !workerRunning && state.queue && state.queue.length > 0) {
        console.log("Retomando envio pendente...");
        startProgressUpdater();
        startWorkerSafe();
    }
});

// ==== safety handlers ====
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));
client.on("rateLimit", (info) => console.warn("Client rateLimit event:", info));

// === login ===
if (!process.env.DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN não encontrado.");
    process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Falha ao logar:", err);
    process.exit(1);
});