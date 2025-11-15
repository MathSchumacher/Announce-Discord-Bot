# 📢 Announce Discord Bot
Por **Matheus Schumacher**

Um bot avançado para envio de **anúncios via DM** no Discord, com suporte a anexos, filtros de usuários, paginação de membros e controle inteligente de rate limit — capaz de funcionar em servidores pequenos ou gigantes (+20.000 membros) com segurança.

---

# ✨ Funcionalidades Principais

### ✅ Enviar anúncios por DM para todos os membros
Comando:
```
!announce Sua mensagem aqui
```

### 📎 Suporte a anexos
Basta anexar imagens, vídeos ou PDFs ao usar o comando.
O bot enviará **a mesma mensagem + anexos** para cada usuário.

### 🚫 Ignorar usuários específicos
Use:
```
!announce Mensagem aqui -{USER_ID}
```
Exemplo:
```
!announce Promoção nova! -{111111111111111111} -{222222222222222222}
```

### 🎯 Enviar somente para usuários específicos
Comando alternativo:
```
!announcefor Mensagem +{USER_ID} +{USER_ID2}
```
Exemplo:
```
!announcefor Teste VIP +{111111111111111111} +{222222222222222222}
```

### 🧩 Paginação + Anti-Travamento
- Envia 1 DM por vez
- Delay automático entre envios (evita rate limit)
- Lê membros por página (não carrega tudo em RAM)
- Funciona em servidores **com dezenas de milhares de membros**

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

- ✔ Server Members Intent
- ✔ Message Content Intent
- ✔ Presence Intent (opcional)

### 5. Pegue o Guild ID (ID do servidor)
Ative o modo desenvolvedor:
- Configurações → Avançado → Modo desenvolvedor
- Clique com botão direito no servidor → "Copiar ID"

---

# 📦 Instalação e Execução Local

### 1. Instale dependências
```
npm install
```

### 2. Crie um arquivo **.env** na raiz
dentro dele:
```
DISCORD_TOKEN=seu_token_aqui
```

### 3. Inicie o bot
```
node index.js
```

---

# 🚀 Deploy na Nuvem (Railway, Render, etc.)

## ▶ Railway (recomendado)
1. Vá em **Variables**
2. Adicione:
```
DISCORD_TOKEN = seu_token
```
3. Deploy → Redeploy

> Não envie seu `.env` para o GitHub.

---

# 📂 Estrutura do Projeto
```
.
├── index.js
├── package.json
├── .gitignore
└── README.md
```
---

# 🧩 Scripts
```
npm start
```
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
Se quiser, posso formatar este README com badges, cores, tabela de comandos ou adicionar screenshots.