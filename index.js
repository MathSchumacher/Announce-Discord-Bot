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
// Atraso individual entre cada DM para parecer humano e evitar rate-limit imediato.
const DELAY_BASE_MS = 10000; 
const DELAY_RANDOM_MS = 10000; 
const BATCH_SIZE = 25; 
// NOVO: Pausa de lote variável entre 1 e 5 minutos (Alto Risco)
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
		return Object.assign({
			active: false,
			text: "",
			attachments: [],
			ignore: [],
			only: [],
            // 'queue' agora armazena apenas a fila global
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
		// Antes de salvar o estado global, persistimos a fila ativa (queue) dentro da guildData.
		if (s.active && s.currentAnnounceGuildId) {
			const currentGuildId = s.currentAnnounceGuildId;
			// move a fila global para a fila de pendentes da guild antes de salvar
			s.guildData[currentGuildId] = s.guildData[currentAnnounceGuildId] || {};
			s.guildData[currentGuildId].pendingQueue = s.queue;
		}

		const copy = {
			active: !!s.active,
			currentAnnounceGuildId: s.currentAnnounceGuildId || null,
			text: s.text || "",
			attachments: Array.isArray(s.attachments) ? s.attachments : [],
			ignore: Array.isArray(s.ignore) ? s.ignore : [],
			only: Array.isArray(s.only) ? s.only : [],
            // A fila global é salva vazia ou com o que restou (será recarregada no ready)
			queue: [], 
			currentRunStats: s.currentRunStats || { success: 0, fail: 0, closed: 0 },
			progressMessageRef: (s.progressMessageRef && s.progressMessageRef.channelId && s.progressMessageRef.messageId) ? s.progressMessageRef : null,
			mode: s.mode || "announce",
			quarantine: !!s.quarantine,
			guildData: s.guildData || {}
		};
		fs.writeFileSync(STATE_FILE, JSON.stringify(copy, null, 2));

        // Limpa a fila global após salvar, para garantir que o workerLoop não a use se o salvamento falhar.
        if (s.active) {
            s.queue = [];
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
	return { cleaned: text.replace(regex, "").trim(), ignore, only };
}

// Garante que cada DM tenha um hash ligeiramente diferente, evitando detecção de spam de conteúdo idêntico.
function getVariedText(baseText) {
	if (!baseText || baseText.length === 0) return "";
	const zeroWidthSpace = "\u200B";
	// Adiciona 1 a 3 caracteres de espaço de largura zero (\u200B) no início
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
				console.warn(`RATE LIMITED (429). Waiting ${backoffMs}ms. Attempt ${attempt}/${RETRY_LIMIT}`);
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
		const embed = new EmbedBuilder()
			.setTitle("📨 Envio em progresso")
			.setColor("#00AEEF")
			.addFields(
				{ name: "Enviadas", value: `${state.currentRunStats.success}`, inline: true },
				{ name: "Falhas", value: `${state.currentRunStats.fail}`, inline: true },
				{ name: "DM Fechada", value: `${state.currentRunStats.closed}`, inline: true },
				{ name: "Restando na Fila", value: `${state.queue.length}`, inline: true }
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
                // Range de 4 minutos (240000ms). Min = 60000ms
                const rangeMs = MAX_BATCH_PAUSE_MS - MIN_BATCH_PAUSE_MS; 
                const pauseDurationMs = MIN_BATCH_PAUSE_MS + Math.floor(Math.random() * rangeMs); 
                const pauseDurationMinutes = (pauseDurationMs / 60000).toFixed(1);

                console.log(`PAUSA DE LOTE: ${messagesSentInBatch} DMs enviadas. Pausando por ${pauseDurationMinutes} minutos.`);
                
                // Salva o estado da fila (queue) antes de pausar
                modifyStateAndSave(s => s.guildData[currentGuildId].pendingQueue = s.queue);
                
                await updateProgressEmbed();
                await wait(pauseDurationMs); 
                
                messagesSentInBatch = 0;
                console.log("Retomando envio após a pausa.");

                // Após a pausa, recarrega a fila do estado (se houve build/reinício)
                if (state.queue.length === 0 && guildData?.pendingQueue?.length > 0) {
                     modifyStateAndSave(s => s.queue = guildData.pendingQueue);
                }
                
                if (state.queue.length === 0) break; // Finaliza se a fila estiver vazia após recarregar
            }
            // --- Fim Pausa de Lote Lógica ---

            // Pega o ID a ser processado
			const userId = state.queue[0];
			
            // Salva a fila ANTES de remover o ID (para que o ID ainda esteja lá se o bot cair após o shift)
            modifyStateAndSave(s => s.guildData[currentGuildId].pendingQueue = s.queue);
            
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
                    // Adiciona o ID à failedQueue (somente falhas de API/DM fechada)
					s.guildData[currentGuildId].failedQueue.push(userId); 
                    // Limpa o ID da pendingQueue (já foi removido da queue principal)
                    const pendingIndex = s.guildData[currentGuildId].pendingQueue.indexOf(userId);
                    if (pendingIndex > -1) {
                        s.guildData[currentGuildId].pendingQueue.splice(pendingIndex, 1);
                    }
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
						break; 
					} else {
						registerFailure(result.reason);
					}
					// Atraso antes de tentar o próximo DM após uma falha de anexo
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
					if (result.reason === "quarantine") {
						console.error("Quarentena detectada; parando worker.");
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
                // Limpa o ID da pendingQueue, pois o sucesso foi garantido
                if (currentGuildId && guildData.pendingQueue) {
                    const pendingIndex = guildData.pendingQueue.indexOf(userId);
                    if (pendingIndex > -1) {
                        modifyStateAndSave(s => s.guildData[currentGuildId].pendingQueue.splice(pendingIndex, 1));
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
	
	// Limpa pendingQueue na finalização
	if (currentAnnounceGuildId && state.guildData[currentAnnounceGuildId]) {
		state.guildData[currentAnnounceGuildId].pendingQueue = [];
	}

	// Verifica se restam falhas
	const remainingFails = currentAnnounceGuildId ? (state.guildData[currentAnnounceGuildId]?.failedQueue?.length || 0) : 0;
	const remainingText = remainingFails > 0 ? `❗ Restam ${remainingFails} falhas. Use **!resume**.` : "✔️ Envio concluído.";

	const embed = new EmbedBuilder()
		.setTitle("📬 Envio Finalizado")
		.setColor(fail > 0 || state.quarantine ? 0xFF0000 : 0x00AEEF)
		.addFields(
			{ name: "Enviadas (Sucesso Total)", value: `${success}`, inline: true },
			{ name: "Falhas (API/Erro)", value: `${fail}`, inline: true },
			{ name: "DM Fechada", value: `${closed}`, inline: true }
		)
		.setFooter({ text: remainingText })
		.setTimestamp();
	
	if (state.quarantine) {
		embed.addFields({ name: "⚠️ QUARENTENA ATIVADA", value: "Seu bot foi marcado. Todos os envios foram interrompidos.", inline: false });
	}
	
	const content = remainingFails > 0 ? remainingText : (state.quarantine ? "❗ Envio interrompido por quarentena." : "✔️ Envio concluído com sucesso.");

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
		// === Lógica de Cooldown na Finalização (SÓ SE A FILA ESTAVA VAZIA) ===
		const wasQueueEmpty = state.queue.length === 0;
		
		if (currentAnnounceGuildId && !state.quarantine && wasQueueEmpty && totalSent > 0) {
			modifyStateAndSave(s => {
				s.guildData[currentAnnounceGuildId] = s.guildData[currentAnnounceGuildId] || {};
				s.guildData[currentAnnounceGuildId].lastAnnounceTime = Date.now();
				s.guildData[currentAnnounceGuildId].totalSuccess = success;
				s.guildData[currentAnnounceGuildId].totalFail = fail;
				s.guildData[currentAnnounceGuildId].totalClosed = closed;
				s.active = false;
				s.currentAnnounceGuildId = null;
			});
		} else {
			// Se o envio foi interrompido (quarentena ou resume), não salva o cooldown e mantém active=false.
			modifyStateAndSave(s => {
                s.active = false;
                s.currentAnnounceGuildId = null;
            });
		}
	}
}

// === Commands and flow ===
client.on("messageCreate", async (message) => {
	try {
		if (message.author.bot || !message.guild) return;
		
		const guildId = message.guild.id;
		const isAnnounceCommand = message.content.startsWith("!announce") || message.content.startsWith("!announcefor");
		const isResumeCommand = message.content.toLowerCase().startsWith("!resume");

		if (!isAnnounceCommand && !isResumeCommand) return;

		if (!state.guildData[guildId]) {
			modifyStateAndSave(s => s.guildData[guildId] = { lastAnnounceTime: 0, totalSuccess: 0, totalFail: 0, totalClosed: 0, failedQueue: [], pendingQueue: [], lastRunText: "", lastRunAttachments: [] });
		}
		const guildSpecificData = state.guildData[guildId];


		// 1. LÓGICA DO COOLDOWN (APENAS PARA !announce)
		if (isAnnounceCommand) {
			// Verifica se já existe um envio globalmente (segurança primária)
			if (state.active) {
				return message.reply("❗ Já existe um envio em andamento **GLOBALMENTE**. Aguarde a conclusão da tarefa atual.");
			}

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
		}


		// 2. PREPARAÇÃO DA FILA (ANNOUNCE & RESUME)
		let queue = [];
		let textToUse = "";
		let attachmentsToUse = [];
		let mode = "announce";
		let parsed = { cleaned: "", ignore: new Set(), only: new Set() };
		
		if (isResumeCommand) {
			// Verifica se já existe um envio globalmente (segurança primária)
			if (state.active) {
				return message.reply("❗ Já existe um envio em andamento **GLOBALMENTE**. Aguarde a conclusão da tarefa atual.");
			}
			
			// Junta a fila de falhas confirmadas e a fila de pendentes (interrompidos)
			const failedQueue = guildSpecificData.failedQueue || [];
			const pendingQueue = guildSpecificData.pendingQueue || [];
			
			// Concatena as duas filas e remove duplicatas (se um ID falhou e depois ficou pendente)
			const uniqueQueue = [...new Set([...failedQueue, ...pendingQueue])];
			
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

		} else if (isAnnounceCommand) {
			
			mode = message.content.startsWith("!announcefor") ? "for" : "announce";
			const raw = message.content.replace("!announcefor", "").replace("!announce", "").trim();
			parsed = parseSelectors(raw);

			attachmentsToUse = [...message.attachments.values()].map(a => a.url);
			textToUse = parsed.cleaned;

			if (!textToUse && attachmentsToUse.length === 0) {
				return message.reply("O comando precisa de texto ou anexo. Use `!announce texto -{id}` ou `!announcefor texto +{id}`.");
			}

			const guild = message.guild;
			try { await guild.members.fetch(); } catch (e) { console.warn("guild.members.fetch() falhou (intents?). Continuando com cache."); }

			guild.members.cache.forEach(m => {
				if (!m || !m.user || m.user.bot) return;
				if (mode === "announce" && parsed.ignore.has(m.id)) return;
				if (mode === "for" && !parsed.only.has(m.id)) return;
				queue.push(m.id);
			});
			
			if (queue.length === 0) {
				return message.reply("A fila de envio está vazia após aplicar os filtros.");
			}
			
			// LIMPA FILAS ANTERIORES E ARMAZENA O CONTEÚDO ATUAL
			modifyStateAndSave(s => {
				s.guildData[guildId].failedQueue = [];
				s.guildData[guildId].pendingQueue = []; // Limpa pendingQueue ao iniciar uma nova campanha
				s.guildData[guildId].lastRunText = textToUse;
				s.guildData[guildId].lastRunAttachments = attachmentsToUse;
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
			currentRunStats: { success: 0, fail: 0, closed: 0 },
			progressMessageRef: null,
			quarantine: state.quarantine, // Mantém o estado de quarentena
			guildData: state.guildData
		};
		saveState(state); // Salva o estado inicial com a fila no pendingQueue

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
	if (state.currentAnnounceGuildId) {
		const currentGuildId = state.currentAnnounceGuildId;
        const guildData = state.guildData[currentGuildId];
        
        // Se o bot estava ativo, mas a fila global (state.queue) está vazia, 
        // recarrega a fila de pendentes (pendingQueue) da guild atual
        if (state.active && guildData?.pendingQueue?.length > 0) {
            state.queue = guildData.pendingQueue;
            console.log(`Auto-resume: Recarregada a fila de ${state.queue.length} IDs pendentes para a guild ${currentGuildId}.`);
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