﻿# **🚀 Announce Discord Bot v2.0: Envio de DMs em massa**
<p align="center">
<img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
<img src="https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js">
<img src="https://img.shields.io/badge/Nodemailer-007bff?style=for-the-badge&logo=nodemailer&logoColor=white" alt="Nodemailer">
<img src="https://img.shields.io/badge/Gemini_AI-8E75B2?style=for-the-badge&logo=google&logoColor=white" alt="Gemini AI">
<img src="https://img.shields.io/badge/Persistência-Dados-lightgrey?style=for-the-badge" alt="Persistência">
</p>

<p align="center">
 <img src="./img/ICON_BOT.png" width="450">
</p>

*Desenvolvido por **Matheus Schumacher**.*

<big>Um sistema avançado de comunicação DM no Discord, projetado para operar com **eficiência máxima** e **segurança proativa** contra bloqueios de serviço (rate limits e quarentena). Equipado com **IA Generativa (Gemini)** para humanização de mensagens e suporte a **comandos Slash (/) e prefixo (!)**. Ideal para servidores de qualquer escala que buscam engajamento direto e confiável.</big>

---

## **✨ Recursos de Nível Empresarial**

### **1\. 🧠 Inteligência Artificial Integrada (Gemini)**

Sistema de variação automática de mensagens usando Google Gemini AI para evitar detecção de spam.

| Recurso | Tecnologia/Mecanismo | Objetivo Estratégico |
| :---- | :---- | :---- |
| **Variação de Texto** | Google Gemini 2.5 Flash | Reescreve cada mensagem de forma única, substituindo 1 palavra por sinônimo aleatório a cada envio. |
| **Personalização Dinâmica** | getAiVariation() | Substitui variáveis de nome do usuário (como {nome}, {username}) pelo nome real do destinatário. |
| **Fallback Seguro** | Try-Catch Robusto | Se a IA falhar, utiliza o texto original sem interromper o envio. |
| **Zero Repetição** | Spintax Generator | Cada mensagem é tratada como única pelo Discord, reduzindo drasticamente o risco de quarentena. |

---

### **2\. 🛡️ Segurança Ativa & Anti-Quarentena**

Nosso worker de envio implementa um algoritmo robusto para simular comportamento humano e desviar de sistemas anti-spam do Discord.

| Recurso | Tecnologia/Mecanismo | Objetivo Estratégico |
| :---- | :---- | :---- |
| **Detecção de Ambiente** | IS_LOCAL vs IS_CLOUD | Ajusta automaticamente delays e lotes entre ambiente de desenvolvimento (rápido) e produção (stealth). |
| **Humanização Adaptativa** | currentDelayBase, currentBatchBase | Varia o intervalo de **16-28s** e o tamanho do lote (**14-31 DMs**) em produção para evitar padrões detectáveis. |
| **Typing Simulation** | calculateTypingTime() | Simula digitação humana baseada no comprimento do texto (2.5s-9s) em 75% dos envios. |
| **Delays Aleatórios Extras** | EXTRA_LONG_DELAY (18% chance) | Adiciona pausas imprevisíveis de até 60s para simular distrações naturais. |
| **Backoff Exponencial** | sendDM (429/Rate Limit) | Aguarda tempos crescentes em caso de Rate Limit temporário, evitando a suspensão. |
| **Pausa de Lote** | workerLoop | Pausa obrigatória de **9 a 18 minutos** a cada lote, simulando o operador humano. |
| **Detecção de Soft-Ban** | SOFT_BAN_THRESHOLD (40% / 10+ tentativas) | Interrompe preventivamente o serviço se a taxa de DMs fechadas for perigosamente alta. |
| **Cooldown de Guilda** | GUILD_COOLDOWN (6h base + 2s/usuário) | Impede campanhas consecutivas imediatas no mesmo servidor. |
| **Filtro de Contas Suspeitas** | isSuspiciousAccount() | Ignora contas com menos de 30 dias ou sem avatar (configurável). |
| **Penalidade por Falha** | Delays Progressivos | Aguarda 5s-20s entre falhas para evitar sobrecarga. |

---

### **3\. 💾 Persistência de Estado & Continuidade (HA/DR)**

A integridade da campanha é garantida por um sistema de salvar/carregar multicamadas, ideal para ambientes de deploy contínuo (CI/CD).

* **StateManager:** Gerencia o estado (state.json), salvando a cada **5 alterações (SAVE_THRESHOLD)** e no encerramento do processo (SIGINT/SIGTERM).  
* **Auto-Resume:** Após um reinício limpo, o bot retoma automaticamente a fila ativa.  
* **🚨 Backup de Emergência (DR):** Em caso de Quarentena, falha crítica ou deploy/troca de token, o sistema envia automaticamente o arquivo de estado (resume_TIMESTAMP.json) por **e-mail (nodemailer)**, precisa configurar EMAIL_USER, EMAIL_PASS e TARGET_EMAIL.  
* **Retomada Forçada:** O comando `!resume` ou `/resume` permite a restauração completa da campanha anexando o arquivo de backup de e-mail.  
  * **Restrição de Guild:** Por segurança e consistência, a restauração por anexo só é válida no **servidor de origem da campanha**.
* **Cache de Membros:** Sistema de cache com TTL de 5 minutos para otimizar consultas e reduzir carga na API do Discord.

---

### **4\. 🚫 Gestão Inteligente de Membros Bloqueados**

Implementação de uma lista permanente de DMs que falham com código **50007 (DM Fechada)**.

* **Lista blockedDMs:** Membros com DMs fechadas são marcados como permanentemente inacessíveis após a primeira falha.  
* **Filtro Ativo:** A lista de bloqueio é aplicada em todos os novos anúncios (`!announce`), atualizações de membros (`!update`) e retomadas (`!resume`), **garantindo que o bot nunca mais desperdice recursos ou risco de quarentena** tentando contatar esses usuários.
* **Persistência por Guilda:** Cada servidor mantém sua própria lista de bloqueios, isolando dados entre comunidades.

---

### **5\. 🔐 Sistema Dual de Privacidade**

Suporte inteligente para comandos Slash (/) e Prefixo (!) com controle automático de privacidade.

| Tipo de Comando | Visibilidade | Painel de Controle | Uso Recomendado |
| :---- | :---- | :---- | :---- |
| **Slash Commands (/)** | Efêmero (Invisível) | Enviado via DM do iniciador | Administradores que querem discrição total |
| **Prefixo (!)** | Público no Canal | Enviado no canal de origem | Equipes que precisam monitorar colaborativamente |

* **Detecção Automática:** O sistema identifica o tipo de comando e ajusta automaticamente o modo de privacidade.
* **Relatórios Privados:** Ao usar `/announce`, todo o painel de progresso e relatório final são enviados **exclusivamente na DM do administrador**.
* **Fallback Inteligente:** Se a DM falhar, o sistema tenta alertas alternativos sem perder dados.

---

## **⚙️ Tecnologias e Arquitetura**

* **Core:** Node.js, **discord.js v14+** (utilizando Intents, Embeds e Attachments).  
* **IA Generativa:** **Google Gemini 2.5 Flash** (Variação de texto em tempo real).
* **Estado:** StateManager (Persistência assíncrona com state.json).  
* **Comunicação:** nodemailer (Para serviços de e-mail críticos, exigindo autenticação App Password/TLS).  
* **Processamento:** workerLoop (Execução segura em lote com pausas adaptativas).
* **Ambiente:** Detecção automática LOCAL/CLOUD para otimização de performance.

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
| **`/status`** | Slash | Exibe estado do sistema (Invisível) | Monitoramento |
| **`!status`** | Prefixo | Exibe estado do sistema (Público) | Monitoramento |

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
| `/resume arquivo: <anexo.json>` | Restaura o estado da campanha a partir do arquivo de backup de emergência. |
| `!resume <anexo.json>` | Restaura o estado da campanha (versão prefixo). |

---

## **🛠 Configuração Rápida**

### **1\. Dependências**

Instale os pacotes necessários:

```bash
npm install discord.js dotenv nodemailer @google/generative-ai
```

### **2\. Variáveis de Ambiente (.env)**

Crie e configure o arquivo .env para habilitar o sistema completo:

```env
# Token do Bot Discord (Obrigatório)
DISCORD_TOKEN=seu_token_aqui

# Gmail - Senha de App (Obrigatório para Backup)
EMAIL_USER=seu_email_que_envia@gmail.com
EMAIL_PASS=sua_senha_de_app_gmail

# E-mail para backups de emergência (Obrigatório)
TARGET_EMAIL=matheusmschumacher@gmail.com

# API Gemini (Opcional - recomendado para stealth máximo)
GEMINI_API_KEY=sua_chave_gemini_aqui
```

**Nota sobre Gemini:** Sem a chave da API, o bot funcionará normalmente mas sem variação de texto (maior risco de detecção). Obtenha gratuitamente em: https://aistudio.google.com/apikey

### **3\. Configuração do Discord**

Certifique-se de que os **Intents Privilegiados** estão ativados no painel de desenvolvedor (Bot → Privileged Gateway Intents):

* ✅ **Presence Intent**
* ✅ **Server Members Intent**  
* ✅ **Message Content Intent**

**Para Comandos Slash:**
* Certifique-se de que o bot tenha a permissão `applications.commands` no convite OAuth2.

### **4\. Inicialização**

```bash
node index.js
```

O bot gerará e utilizará o arquivo `state.json` para manter o estado da campanha.

---

## **📊 Monitoramento & Métricas**

### **Informações Exibidas no `/status` ou `!status`**

| Métrica | Descrição |
| :---- | :---- |
| **Estado** | 🟢 Ativo ou ⚪ Parado |
| **Pendentes** | Membros que ainda não receberam a mensagem |
| **Fila Atual** | Membros sendo processados no momento |
| **🚫 DMs Fechadas** | Total de membros com DM bloqueada (permanente) |
| **Cooldown** | Tempo restante até poder iniciar nova campanha |

### **Relatório Final (Automático)**

Ao concluir ou pausar uma campanha, o sistema gera automaticamente um embed com:

* ✅ **Sucesso:** Total de mensagens entregues
* ❌ **Falhas (Erro):** Falhas técnicas temporárias
* 🚫 **DMs Fechadas:** Usuários com privacidade ativada
* ⏳ **Pendentes:** Membros restantes na fila

---

## **🌍 Detecção de Ambiente**

O bot detecta automaticamente se está rodando em:

### **LOCAL (PC - Desenvolvimento)**
- Delays reduzidos (2-5s)
- Lotes menores (10-18 membros)
- Pausas curtas (3s entre lotes)
- Ideal para testes rápidos

### **NUVEM (Heroku/Railway/Render - Produção)**
- Delays longos (16-28s + extras aleatórios)
- Lotes maiores (14-31 membros)
- Pausas longas (9-18min entre lotes)
- Stealth máximo ativado

**Variáveis de Detecção:** `DYNO`, `RAILWAY_ENVIRONMENT`, `RENDER`, `PORT`

---

## **🚨 Sistema de Alerta & Recuperação**

### **Causas de Backup Automático por E-mail:**

1. ⚠️ **Quarentena/Flag 40003** - API detectou spam
2. 🔴 **Soft-Ban** - Taxa de rejeição > 40%
3. 🛑 **Stop Manual** - Administrador pausou envio
4. 💥 **Erro Crítico no Worker** - Falha técnica inesperada
5. 🔄 **Shutdown do Sistema** - SIGINT/SIGTERM recebido

### **Procedimento de Recuperação:**

1. Verifique seu e-mail (TARGET_EMAIL)
2. Baixe o arquivo `resume_TIMESTAMP.json` anexado
3. Use `/resume` ou `!resume` e **anexe o arquivo**
4. O bot restaurará exatamente de onde parou

---

## **⚙️ Configurações Avançadas**

Personalize o comportamento editando as constantes no código:

```javascript
// Segurança & Performance
const MIN_ACCOUNT_AGE_DAYS = 30;           // Idade mínima da conta (dias)
const IGNORE_NO_AVATAR = true;              // Ignora contas sem avatar
const SOFT_BAN_THRESHOLD = 0.4;             // 40% de rejeição = parada
const SOFT_BAN_MIN_SAMPLES = 10;            // Mínimo de tentativas antes de avaliar

// Cooldown
const GUILD_COOLDOWN_MIN_HOURS = 6;         // Cooldown base (horas)
const COOLDOWN_PENALTY_MS_PER_USER = 2000;  // +2s por usuário enviado

// Stealth
const EXTRA_LONG_DELAY_CHANCE = 0.18;       // 18% chance de delay extra
const EXTRA_LONG_DELAY_MS = 35000;          // Delay extra de 35s

// Persistência
const SAVE_THRESHOLD = 5;                   // Salva a cada 5 mudanças
const MEMBER_CACHE_TTL = 5 * 60 * 1000;     // Cache expira em 5min
```

---

## **🔧 Solução de Problemas**

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
- Aumente os delays editando `currentDelayBase`
- Reduza o tamanho dos lotes editando `currentBatchBase`

---

## **🤝 Contribuição e Licença**

Pull requests, relatórios de bugs e sugestões são bem-vindos.

**Recursos Futuros Planejados:**
- [ ] Suporte a múltiplas línguas na IA
- [ ] Dashboard web de monitoramento
- [ ] Integração com banco de dados externo
- [ ] Suporte a campanhas agendadas

Código desenvolvido por **Matheus Schumacher**. Uso livre sob licença MIT.

---

## **📜 Changelog**

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

<p align="center">
 <strong>⚡ Powered by Discord.js, Gemini AI & Human Behavior Science ⚡</strong>
</p>