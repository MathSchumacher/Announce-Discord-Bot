# 📢 Announce Discord Bot
Por **Matheus Schumacher**

Um bot avançado para envio de **anúncios via DM** no Discord, com suporte a anexos, filtros de usuários, e controle **inteligente e robusto** de rate limit. É capaz de funcionar em servidores pequenos ou gigantes (+20.000 membros) com segurança.

---

# ✨ Funcionalidades Principais

### ✅ Enviar anúncios por DM para todos os membros
Comando:
!announce Sua mensagem aqui


### 📎 Suporte a anexos
Basta anexar imagens, vídeos ou PDFs ao usar o comando.
O bot enviará **a mesma mensagem + anexos** para cada usuário.

### 🚫 Ignorar usuários específicos
Use:
!announce Mensagem aqui -{USER_ID}

Exemplo:
!announce Promoção nova! -{111111111111111111} -{222222222222222222}


### 🎯 Enviar somente para usuários específicos
Comando alternativo:
!announcefor Mensagem +{USER_ID} +{USER_ID2}

Exemplo:
!announcefor Teste VIP +{111111111111111111} +{222222222222222222}


### 🔄 Retomar Campanhas Interrompidas
O bot armazena os membros não alcançados (falhas ou pendentes) em caso de queda, expulsão ou pausa.
Comando:
!resume

*O `!resume` tenta reenviar a última mensagem para todos os membros que não a receberam.*

### 🧩 Paginação + Anti-Travamento
- Envia 1 DM por vez
- Delay automático entre envios (evita rate limit)
- **Pausa de Lote Variável:** Após 25 DMs, pausa randomicamente por 1 a 5 minutos.
- Funciona em servidores **com dezenas de milhares de membros**

---

# 🛡 Sistema de Segurança e Cooldown

O bot foi construído com mecanismos proativos para evitar a **Quarentena da Aplicação (App Quarantine)** do Discord.

### ⏲ Cooldown Dinâmico (Por Servidor)
O bot impõe um tempo de espera para novos anúncios (`!announce`):
- **Base:** 6 horas.
- **Penalidade:** O tempo de espera aumenta com base no número de DMs enviadas na campanha anterior, agindo como uma medida anti-spam robusta.

---

# 🛠 Como Criar Seu Bot no Discord

### 1. Acesse o painel de desenvolvedor
🔗 https://discord.com/developers/applications

### 2. Crie uma nova aplicação
Bot → "Add Bot"

### 3. Pegue o Token do Bot
Em **Bot → Token**

> ⚠️ **Nunca compartilhe seu token!**

### 4. Ative os Intents Necessários
Em **Bot → Privileged Gateway Intents**:

- ✔ **Server Members Intent** (Essencial para listar membros)
- ✔ **Message Content Intent** (Essencial para ler o comando e a mensagem)
- ✔ Presence Intent (opcional)

### 5. Pegue o Guild ID (ID do servidor)
Ative o modo desenvolvedor:
- Configurações → Avançado → Modo desenvolvedor
- Clique com botão direito no servidor → "Copiar ID"

---

# 📦 Instalação e Execução Local

### 1. Instale dependências
npm install


### 2. Crie um arquivo **.env** na raiz
dentro dele:
DISCORD_TOKEN=seu_token_aqui


### 3. Inicie o bot
node index.js


---

# 🚀 Deploy na Nuvem (Railway, Render, etc.)

## ▶ Railway (recomendado)
1. Vá em **Variables**
2. Adicione:
DISCORD_TOKEN = seu_token

3. Deploy → Redeploy

> Não envie seu `.env` para o GitHub.

---

# 📂 Estrutura do Projeto
. ├── index.js ├── package.json ├── .gitignore └── README.md

---

# 🧩 Scripts
npm start

(Executa `node index.js`)

---

# 🤝 Contribuição
Pull requests são bem-vindos.

1. Fork o repositório
2. Crie uma branch
3. Faça commits claros
4. Envie PR

---

# 🛡 Licença
Código desenvolvido por **Matheus Schumacher**.
Uso livre.

---