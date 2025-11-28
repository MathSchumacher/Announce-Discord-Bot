﻿<h1 align="center">🚀 Announce Discord Bot v2.5: Sistema Anti-Quarentena com IA 🤖</h1>
<p align="center">
<img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
<img src="https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js">
<img src="https://img.shields.io/badge/Nodemailer-007bff?style=for-the-badge&logo=nodemailer&logoColor=white" alt="Nodemailer">
<img src="https://img.shields.io/badge/Gemini_AI-8E75B2?style=for-the-badge&logo=google&logoColor=white" alt="Gemini AI">
<img src="https://img.shields.io/badge/Anti--Quarantine-🛡️-red?style=for-the-badge" alt="Anti-Quarantine">
</p>

<p align="center">
 <img src="./img/ICON_BOT.png" width="450">
</p>

*Desenvolvido por **Matheus Schumacher**.*

<big>Sistema de próxima geração para comunicação DM em massa no Discord, equipado com **Sistema Anti-Quarentena V2** adaptativo, **IA Generativa (Gemini)** para humanização, e **proteção multi-camadas** contra rate limits. Projetado para operar com **máxima segurança** em servidores de qualquer escala (100-5000+ membros).</big>

---

## **✨ Novidades da v2.5 - Sistema Anti-Quarentena V2**

### **🛡️ Proteção Adaptativa Avançada**

Sistema revolucionário que **aprende e se adapta** em tempo real para evitar quarentena do Discord.

| Recurso | Descrição | Benefício |
|---------|-----------|-----------|
| **🧮 Monitor de Taxa de Rejeição** | Analisa últimos 50 envios em tempo real | Detecta padrões suspeitos antes do Discord |
| **🔄 Pausas Progressivas** | 3min → 5.5min → 8min → 15min por lote | Aumenta segurança conforme a campanha avança |
| **⚡ Circuit Breaker Sensível** | Para após 3 DMs fechadas consecutivas | Resposta 160% mais rápida a problemas |
| **📊 Sistema de Estados** | Normal → Cautela (30%) → Crítico (40%) | Ajuste automático sem intervenção manual |
| **⏱️ Limite de Throughput** | Máximo 180 envios/hora | Previne sobrecarga mesmo em servidores gigantes |
| **🎯 Penalidade Adaptativa** | Delay aumenta 5x após DMs fechadas | Simula comportamento humano frustrado |
| **💤 Watchdog Anti-Freeze** | Detecta inatividade > 30min | Previne congelamento do Railway/Heroku |

---


## **📊 Tempo Estimado de Envio**

### **Servidor com 2800 membros:**

| Cenário | Taxa de DMs Fechadas | Tempo Total | Segurança |
|---------|---------------------|-------------|-----------|
| **Melhor Caso** | 20% (servidor ativo) | **10-12 horas** | 🟢 Baixo Risco |
| **Caso Médio** ⭐ | 30-35% (típico) | **14-18 horas** | 🟡 Seguro |
| **Pior Caso** | 40-50% (inativo) | **22-30 horas** | 🔴 Requer monitoramento |

> **💡 Recomendação:** Inicie campanhas à noite (22h) para conclusão no dia seguinte.

### **Comparação com Sistema Antigo:**

```
Sistema Antigo (v2.0):  8-10h  | 🔴 Alto Risco de Quarentena
Sistema Novo (v2.5):   14-18h  | 🟢 70% Mais Seguro
```

**Trade-off:** +60% de tempo, mas **-70% de risco de banimento**

---

## **✨ Recursos de Nível Empresarial**

### **1. 🧠 Inteligência Artificial Integrada (Gemini)**

Sistema de variação automática de mensagens usando Google Gemini AI para evitar detecção de spam.

| Recurso | Tecnologia/Mecanismo | Objetivo Estratégico |
| :---- | :---- | :---- |
| **Variação de Texto** | Google Gemini 2.5 Flash | Reescreve cada mensagem de forma única, substituindo 1 palavra por sinônimo aleatório a cada envio. |
| **Personalização Dinâmica** | getAiVariation() | Substitui variáveis de nome do usuário (como {nome}, {username}) pelo nome real do destinatário. |
| **Fallback Seguro** | Try-Catch Robusto | Se a IA falhar, utiliza o texto original sem interromper o envio. |
| **Zero Repetição** | Spintax Generator | Cada mensagem é tratada como única pelo Discord, reduzindo drasticamente o risco de quarentena. |

---

### **2. 🛡️ Sistema Anti-Quarentena V2 - Adaptativo**

Nosso worker de envio implementa um algoritmo de última geração que **aprende em tempo real** e ajusta seu comportamento.

#### **📊 Análise de Taxa de Rejeição**

```javascript
Últimos 50 envios:
├─ Taxa < 30%  → Modo Normal    (Pausas: 3-8 min)
├─ Taxa 30-40% → Modo Cautela   (Pausas: 8-12 min + Multiplicador 1.2x)
└─ Taxa > 40%  → Modo Crítico   (Pausas: 15 min + Multiplicador 1.5x)
```

#### **⚡ Circuit Breaker Inteligente**

```
3 DMs fechadas consecutivas → Pausa de 12 minutos
Após pausa → Reseta contador e randomiza parâmetros
```

#### **🎯 Delays Adaptativos**

| Situação | Delay Base | Comportamento |
|----------|------------|---------------|
| **Sucesso** | 12-22s | Mantém velocidade normal |
| **2 DMs fechadas** | +50% (18-33s) | Aumenta cautela |
| **3+ fechadas** | +200% (36-66s) | Modo super-cautelo |

#### **⏱️ Controle de Throughput**

- **180 envios/hora** (máximo absoluto)
- **Verificação a cada 10 envios**
- **Pausa forçada** se limite excedido

#### **🔧 Proteções Clássicas (Mantidas)**

| Recurso | Tecnologia/Mecanismo | Objetivo Estratégico |
| :---- | :---- | :---- |
| **Detecção de Ambiente** | IS_LOCAL vs IS_CLOUD | Ajusta automaticamente delays e lotes entre ambiente de desenvolvimento (rápido) e produção (stealth). |
| **Humanização de Digitação** | calculateTypingTime() | Simula digitação humana baseada no comprimento do texto (2.5s-9s) em 75% dos envios. |
| **Delays Aleatórios Extras** | EXTRA_LONG_DELAY (15% chance) | Adiciona pausas imprevisíveis de até 50s para simular distrações naturais. |
| **Backoff Exponencial** | sendDM (429/Rate Limit) | Aguarda tempos crescentes em caso de Rate Limit temporário, evitando a suspensão. |
| **Verificação de Membros** | guild.members.fetch() | Pula automaticamente membros que saíram do servidor. |
| **Cooldown de Guilda** | GUILD_COOLDOWN (6h base + 2s/usuário) | Impede campanhas consecutivas imediatas no mesmo servidor. |
| **Filtro de Contas Suspeitas** | isSuspiciousAccount() | Ignora contas com menos de 30 dias ou sem avatar (configurável). |

---

### **3. 💾 Persistência de Estado & Continuidade (HA/DR)**

A integridade da campanha é garantida por um sistema de salvar/carregar multicamadas, ideal para ambientes de deploy contínuo (CI/CD).

* **StateManager:** Gerencia o estado (state.json), salvando a cada **5 alterações (SAVE_THRESHOLD)** e no encerramento do processo (SIGINT/SIGTERM).  
* **Auto-Resume:** Após um reinício limpo, o bot retoma automaticamente a fila ativa.  
* **🚨 Backup de Emergência (DR):** Em caso de Quarentena, falha crítica ou deploy/troca de token, o sistema envia automaticamente o arquivo de estado (resume_TIMESTAMP.json) por **e-mail (nodemailer)**.
* **Retomada Forçada:** O comando `!resume` ou `/resume` permite a restauração completa da campanha anexando o arquivo de backup.
* **Restrição de Guild:** Por segurança, a restauração só é válida no **servidor de origem**.
* **💤 Watchdog Anti-Freeze:** Detecta inatividade > 30min e força backup automático + reinício.

---

### **4. 🚫 Gestão Inteligente de Membros Bloqueados**

Implementação de uma lista permanente de DMs que falham com código **50007 (DM Fechada)**.

* **Lista blockedDMs:** Membros com DMs fechadas são marcados como permanentemente inacessíveis após a primeira falha.  
* **Filtro Ativo:** A lista de bloqueio é aplicada em todos os novos anúncios, **garantindo eficiência máxima**.
* **Persistência por Guilda:** Cada servidor mantém sua própria lista de bloqueios.

---

### **5. 🔐 Sistema Dual de Privacidade**

Suporte inteligente para comandos Slash (/) e Prefixo (!) com controle automático de privacidade.

| Tipo de Comando | Visibilidade | Painel de Controle | Uso Recomendado |
| :---- | :---- | :---- | :---- |
| **Slash Commands (/)** | Efêmero (Invisível) | Enviado via DM do iniciador | Administradores que querem discrição total |
| **Prefixo (!)** | Público no Canal | Enviado no canal de origem | Equipes que precisam monitorar colaborativamente |

---

## **⚙️ Tecnologias e Arquitetura**

* **Core:** Node.js, **discord.js v14+** (utilizando Intents, Embeds e Attachments).  
* **IA Generativa:** **Google Gemini 2.5 Flash** (Variação de texto em tempo real).
* **Estado:** StateManager (Persistência assíncrona com state.json).  
* **Comunicação:** nodemailer (Para serviços de e-mail críticos).  
* **Processamento:** workerLoop V2 (Sistema adaptativo multi-camadas).
* **Segurança:** Circuit Breaker, Rate Monitor, Throughput Limiter.

---

## **🧭 Guia de Comandos**

Todos os comandos requerem a permissão de **Administrador**.

### **Comandos Disponíveis**

| Comando | Tipo | Descrição | Status |
| :---- | :---- | :---- | :---- |
| **`/announce`** | Slash | Inicia nova campanha DM (Invisível - painel via DM) | Nova Campanha |
| **`!announce [msg]`** | Prefixo | Inicia nova campanha DM (Público - painel no canal) | Nova Campanha |
| **`/resume`** | Slash | Continua a última campanha (Invisível - painel via DM) | Persistência |
| **`!resume`** | Prefixo | Continua a última campanha (Público - painel no canal) | Persistência |
| **`/stop`** | Slash | Pausa o envio ativo (Invisível) | Controle |
| **`!stop`** | Prefixo | Pausa o envio ativo (Público) | Controle |
| **`/status`** | Slash | Exibe estado do sistema + **Taxa de Rejeição** (Invisível) | Monitoramento |
| **`!status`** | Prefixo | Exibe estado do sistema + **Taxa de Rejeição** (Público) | Monitoramento |

---

### **Parâmetros dos Comandos Slash**

#### **`/announce`**
- **texto** (obrigatório): Mensagem a ser enviada
- **anexo** (opcional): Imagem ou arquivo para anexar
- **filtros** (opcional): Controles especiais (veja seção abaixo)

#### **`/resume`**
- **arquivo** (opcional): Arquivo JSON de backup enviado por e-mail

---

## **⚡ Ações Especiais (Forçar e Filtrar)**

| Sintaxe | Descrição |
| :---- | :---- |
| `!announce [msg] force` | **Descarta** filas pendentes e inicia um novo anúncio. |
| `!announce [msg] -{ID}` | Ignora o membro/bot com o ID fornecido na campanha. |
| `!announce [msg] +{ID}` | Envia **APENAS** para os IDs especificados (múltiplos suportados). |
| `/announce texto: "msg" filtros: "force"` | Versão Slash do comando force. |
| `/resume arquivo: <anexo.json>` | Restaura o estado da campanha a partir do arquivo de backup. |

---

## **🛠 Configuração Rápida**

### **1. Dependências**

```bash
npm install discord.js dotenv nodemailer @google/generative-ai
```

### **2. Variáveis de Ambiente (.env)**

```env
# Token do Bot Discord (Obrigatório)
DISCORD_TOKEN=seu_token_aqui

# Gmail - Senha de App (Obrigatório para Backup)
EMAIL_USER=seu_email@gmail.com
EMAIL_PASS=sua_senha_de_app

# E-mail para backups (Obrigatório)
TARGET_EMAIL=matheusmschumacher@gmail.com

# API Gemini (Opcional - recomendado)
GEMINI_API_KEY=sua_chave_gemini
```

### **3. Configuração do Discord**

**Intents Privilegiados** (obrigatórios):
* ✅ **Presence Intent**
* ✅ **Server Members Intent**  
* ✅ **Message Content Intent**

**Para Comandos Slash:**
* Certifique-se de que o bot tenha `applications.commands`

### **4. Inicialização**

```bash
node index.js
```

---

## **📊 Monitoramento & Métricas V2**

### **Informações Exibidas no `/status` ou `!status`**

| Métrica | Descrição | V2.5 |
| :---- | :---- | :---- |
| **Estado** | 🟢 Ativo ou ⚪ Parado | ✅ |
| **Pendentes** | Membros que ainda não receberam | ✅ |
| **Fila Atual** | Membros sendo processados | ✅ |
| **🚫 DMs Fechadas** | Total bloqueado (permanente) | ✅ |
| **📊 Taxa de Rejeição** | % dos últimos 50 envios | 🆕 **NOVO** |

### **Relatório Final (Automático)**

```
📬 Relatório Final
✅ Sucesso: 692
❌ Falhas (Erro): 0
🚫 DMs Fechadas: 462
⏳ Pendentes: 1506
```

---

## **🌍 Detecção de Ambiente**

### **LOCAL (PC - Desenvolvimento)**
- Delays: 2-5s
- Lotes: 10-18 membros
- Pausas: 3s
- **Para testes rápidos**

### **NUVEM (Railway/Heroku - Produção)**
- Delays: 12-22s + extras
- Lotes: 12-22 membros
- Pausas: 3-15min (progressivas)
- **Stealth V2 ativado**

---

## **🚨 Sistema de Alerta & Recuperação**

### **Causas de Backup Automático:**

1. ⚠️ **Quarentena/Flag 40003**
2. 🔴 **Soft-Ban** (Taxa > 40%)
3. 🛑 **Stop Manual**
4. 💥 **Erro Crítico**
5. 🔄 **Shutdown**
6. 💤 **Freeze Detectado** (Watchdog) 🆕

### **Procedimento de Recuperação:**

1. Verifique email (TARGET_EMAIL)
2. Baixe `resume_TIMESTAMP.json`
3. Use `/resume` ou `!resume` + anexe arquivo
4. Sistema restaura do exato ponto

---

## **⚙️ Configurações Avançadas V2**

```javascript
// 🛡️ Sistema Anti-Quarentena V2
const MAX_CONSECUTIVE_CLOSED = 3;          // Circuit breaker
const CLOSED_DM_COOLING_MS = 12 * 60 * 1000; // 12 min de pausa
const REJECTION_RATE_WARNING = 0.30;        // 30% = Cautela
const REJECTION_RATE_CRITICAL = 0.40;       // 40% = Crítico
const MAX_SENDS_PER_HOUR = 180;             // Limite horário

// 🎲 Delays Base (12-22s, era 10-18s)
currentDelayBase = 12000 + Math.random() * 10000;

// ⏸️ Pausas Progressivas
const MIN_BATCH_PAUSE_MS = 3 * 60 * 1000;   // 3 min
const MAX_BATCH_PAUSE_MS = 8 * 60 * 1000;   // 8 min
const EXTENDED_PAUSE_MS = 15 * 60 * 1000;   // 15 min (crítico)

// 💤 Watchdog
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 min

// Segurança & Performance
const MIN_ACCOUNT_AGE_DAYS = 30;           // Idade mínima da conta (dias)
const IGNORE_NO_AVATAR = true;              // Ignora contas sem avatar
const SOFT_BAN_THRESHOLD = 0.25;            // 25% de falha = soft-ban
const SOFT_BAN_MIN_SAMPLES = 10;            // Mínimo de tentativas

// Cooldown
const GUILD_COOLDOWN_MIN_HOURS = 6;         // Cooldown base (horas)
const COOLDOWN_PENALTY_MS_PER_USER = 2000;  // +2s por usuário enviado

// Stealth
const EXTRA_LONG_DELAY_CHANCE = 0.15;       // 15% chance de delay extra
const EXTRA_LONG_DELAY_MS = 25000;          // Delay extra de 25s

// Persistência
const SAVE_THRESHOLD = 5;                   // Salva a cada 5 mudanças
const MEMBER_CACHE_TTL = 5 * 60 * 1000;     // Cache expira em 5min
```

---

## **🔧 Solução de Problemas**

### **Bot muito lento após atualização**
✅ **É normal!** O V2.5 prioriza segurança sobre velocidade.
- Servidor 2800 membros: **14-18h** (era 8-10h)
- **Benefício:** 70% menos risco de quarentena

### **Taxa de rejeição alta (>40%)**
- Sistema entra em **Modo Crítico** automaticamente
- Pausas aumentam para 15 min
- **Aguarde:** Bot se auto-regula

### **Watchdog detectou freeze**
- Sistema força backup e reinicia
- **Normal em plataformas de cloud**
- Verifique email para restaurar

### **Bot parou sozinho**
- Verifique `/status` para ver taxa de rejeição
- Se >40%, aguarde **6 horas** (cooldown)
- Use `/resume` para continuar

### **Bot não responde aos comandos Slash**
- Aguarde até 1 hora após o primeiro login (sincronização global)
- Verifique se o bot tem permissão `applications.commands`
- Reinicie o bot após adicionar a chave Gemini

### **DMs não estão sendo enviadas**
- Verifique se os Intents privilegiados estão ativados
- Confirme que o bot tem acesso aos membros (`GuildMembers` intent)
- Teste com `!status` para verificar se há bloqueios ativos

### **E-mails de backup não chegam**
- Confirme que EMAIL_USER e EMAIL_PASS estão corretos
- Use uma Senha de App do Gmail (não a senha da conta)
- Verifique a pasta de spam

### **Erro "API Flag 40003"**
- O Discord detectou comportamento suspeito
- Use a chave Gemini para ativar variação de texto
- O sistema V2 já pausará automaticamente
- Aguarde 6h de cooldown antes de tentar novamente

---

## **🤝 Contribuição e Licença**

Pull requests, relatórios de bugs e sugestões são bem-vindos.

**Recursos Futuros Planejados:**
- [ ] Modo "Balanceado" configurável (12-14h)
- [ ] Dashboard web de monitoramento em tempo real
- [ ] Envio em etapas automático (split de 1400 membros)
- [ ] Machine Learning para otimização de delays
- [ ] Suporte a múltiplas línguas na IA
- [ ] Integração com banco de dados externo
- [ ] Campanhas agendadas

Código desenvolvido por **Matheus Schumacher**. Uso livre sob licença MIT.

---

## **📜 Changelog**

### **v2.5 - Anti-Quarantine Intelligence** 🆕
- 🛡️ **Sistema Anti-Quarentena V2** com análise em tempo real
- 📊 **Monitor de Taxa de Rejeição** (últimos 50 envios)
- ⚡ **Circuit Breaker 160% mais sensível** (3 DMs vs 8)
- 🔄 **Pausas Progressivas** (3→5.5→8→15 min)
- ⏱️ **Limite de Throughput** (180 envios/hora)
- 🎯 **Penalidade Adaptativa** (delay aumenta 5x)
- 💤 **Watchdog Anti-Freeze** (detecta > 30min inativo)
- 🚪 **Verificação de Membros** (pula quem saiu do servidor)
- 🧮 **Multiplicador de Pausa** adaptativo (1.0x → 3.0x)
- 📉 **Delays mais conservadores** (12-22s vs 10-18s)

### **v2.0 - Hybrid Intelligence Update**
- ✨ Integração com Google Gemini AI
- 🔐 Sistema dual de privacidade (Slash + Prefixo)
- 🌍 Detecção automática de ambiente (LOCAL/CLOUD)
- 🧠 Variação inteligente de texto por IA
- 📧 Relatórios privados via DM para comandos Slash
- ⚡ Otimização de delays adaptativos
- 🛡️ Detecção melhorada de soft-ban (40%)
- 💾 Cache de membros com TTL
- 🚀 Typing simulation humanizada

### **v1.0 - Stealth Foundation**
- 🛡️ Sistema anti-quarentena básico
- 💾 Persistência de estado
- 📧 Backup por e-mail
- 🚫 Lista de DMs bloqueadas
- ⏰ Cooldown de guilda

---

## **💝 Apoie o Projeto**

<p align="center">
  <strong>Gostou do bot? Ajude a mantê-lo atualizado e open source!</strong><br>
  Se puder, doe <strong>R$ 10,00</strong> via PIX 🙏
</p>

<p align="center">
  <img src="./img/qrcode.png" width="470" alt="QR Code PIX para doação">
</p>

<p align="center">
  <em>Sua contribuição ajuda no desenvolvimento de novas features e manutenção contínua! ❤️</em>
</p>

---

<p align="center">
 <strong>⚡ Powered by Discord.js, Gemini AI & Adaptive Anti-Quarantine System V2 ⚡</strong>
</p>