# **🚀 Announce Discord Bot: **Envio de DMs em massa****
<p align="center">
<img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
<img src="https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js">
<img src="https://img.shields.io/badge/Nodemailer-007bff?style=for-the-badge&logo=nodemailer&logoColor=white" alt="Nodemailer">
<img src="https://img.shields.io/badge/Persistência-Dados-lightgrey?style=for-the-badge" alt="Persistência">
</p>

<p align="center">
 <img src="./img/ICON_BOT.png" width="450">
</p>


*Desenvolvido por **Matheus Schumacher**.*

<big>Um sistema avançado de comunicação DM no Discord, projetado para operar com **eficiência máxima** e **segurança proativa** contra bloqueios de serviço (rate limits e quarentena). Ideal para servidores de qualquer escala que buscam engajamento direto e confiável.</big>

---

## **✨ Recursos de Nível Empresarial**

### **1\. 🛡️ Segurança Ativa & Anti-Quarentena**

Nosso worker de envio implementa um algoritmo robusto para simular comportamento humano e desviar de sistemas anti-spam do Discord.

| Recurso | Tecnologia/Mecanismo | Objetivo Estratégico |
| :---- | :---- | :---- |
| **Humanização** | currentDelayBase, currentBatchBase | Varia o intervalo de **10s a 20s** e o tamanho do lote (**20-30 DMs**) para evitar padrões detectáveis. |
| **Backoff Exponencial** | sendDM (429/Rate Limit) | Aguarda tempos crescentes em caso de Rate Limit temporário, evitando a suspensão. |
| **Pausa de Lote** | workerLoop | Pausa obrigatória de **10 a 20 minutos** a cada lote, simulando o operador humano. |
| **Detecção de Soft-Ban** | SOFT\_BAN\_THRESHOLD (80% / 20+ tentativas) | Interrompe preventivamente o serviço se a taxa de DMs fechadas for perigosamente alta. |
| **Penalidade por Falha** | penalityTime | Interrompe o serviço por 60s se uma DM fechada barrar o envio ou por 30s se um envio falhar. |
---
### **2\. 💾 Persistência de Estado & Continuidade (HA/DR)**

A integridade da campanha é garantida por um sistema de salvar/carregar multicamadas, ideal para ambientes de deploy contínuo (CI/CD).

* **StateManager:** Gerencia o estado (state.json), salvando a cada **5 alterações (SAVE\_THRESHOLD)** e no encerramento do processo (SIGINT/SIGTERM).  
* **Auto-Resume:** Após um reinício limpo, o bot retoma automaticamente a fila ativa.  
* **🚨 Backup de Emergência (DR):** Em caso de Quarentena, falha crítica ou deploy/troca de token, o sistema envia automaticamente o arquivo de estado (resume\_list.json) por **e-mail (nodemailer)**, precisa configurar EMAIL_USER, EMAIL_PASS e TARGET_EMAIL.  
* **Retomada Forçada:** O comando \!resume permite a restauração completa da campanha anexando o arquivo de backup de e-mail.  
  * **Restrição de Guild:** Por segurança e consistência, a restauração por anexo só é válida no **servidor de origem da campanha**.
---
### **3\. 🚫 Gestão Inteligente de Membros Bloqueados**

Implementação de uma lista permanente de DMs que falham com código **50007 (DM Fechada)**.

* **Lista blockedDMs:** Membros com DMs fechadas são marcados como permanentemente inacessíveis após a primeira falha.  
* **Filtro Ativo:** A lista de bloqueio é aplicada em todos os novos anúncios (\!announce), atualizações de membros (\!update) e retomadas (\!resume), **garantindo que o bot nunca mais desperdice recursos ou risco de quarentena** tentando contatar esses usuários.

---

## **⚙️ Tecnologias e Arquitetura**

* **Core:** Node.js, **discord.js v14+** (utilizando Intents, Embeds e Attachments).  
* **Estado:** StateManager (Persistência assíncrona com state.json).  
* **Comunicação:** nodemailer (Para serviços de e-mail críticos, exigindo autenticação App Password/TLS).  
* **Processamento:** workerLoop (Execução segura em lote com pausas).

---

## **🧭 Guia de Comandos**

Todos os comandos requerem a permissão de **Administrador**.

| Comando | Descrição | Status |
| :---- | :---- | :---- |
| **\!announce \[msg\]** | Inicia nova campanha DM para membros elegíveis (ignora bloqueados). | Nova Campanha |
| **\!announcefor \[msg\]** | Inicia campanha **apenas** para IDs específicos (+{ID}). | Filtro \+{ID} |
| **\!resume** | Continua a última campanha interrompida **(Suporta anexo JSON de backup)**. | Persistência |
| **\!stop** | Pausa o envio ativo, movendo a fila atual para pendentes. | Controle |
| **\!status** | Exibe estado, cooldown, contagem de Pendentes/Falhas e **Membros Bloqueados**. | Monitoramento |
| **\!update** | Adiciona novos membros (que entraram desde a última campanha) à fila pendente, **filtrando bloqueados**. | Manutenção |
---
## **⚡Ações Especiais (Forçar e Filtrar)**

| Sintaxe | Descrição |
| :---- | :---- |
| `!announce [msg] force` | **Descarta** filas pendentes e inicia um novo anúncio. |
| `!announce [msg] -{ID}` | Ignora o membro/bot com o ID fornecido na campanha. |
| `!resume <anexo.json>` | Restaura o estado da campanha a partir do arquivo de backup de emergência. |

---

## **🛠 Configuração Rápida**

### **1\. Dependências**

Instale os pacotes necessários:

```
npm install discord.js dotenv nodemailer
```

### **2\. Variáveis de Ambiente (.env)**

Crie e configure o arquivo .env para habilitar o sistema de backup:

```
DISCORD_TOKEN=seu_token_aqui

# Gmail (Senha de App)
EMAIL_USER=seu_email_que_envia@gmail.com
EMAIL_PASS=sua_senha_de_app_gmail

# E-mail para backups de emergência
TARGET_EMAIL=matheusmschumacher@gmail.com
```

### **3\. Configuração do Discord**

Certifique-se de que os **Intents Privilegiados** estão ativados no painel de desenvolvedor (Bot \-\> Privileged Gateway Intents):

* ✅ **Presence Intent**
* ✅ **Server Members Intent**  
* ✅ **Message Content Intent**

### **4\. Inicialização**

```
node index.js
```

O bot gerará e utilizará o arquivo state.json para manter o estado da campanha.

---

## **🤝 Contribuição e Licença**

Pull requests, relatórios de bugs e sugestões são bem-vindos.

Código desenvolvido por **Matheus Schumacher**. Uso livre.
