const { Client, GatewayIntentBits } = require("discord.js");

// ============ CONFIGURAÇÃO ============
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;           // URL do seu site + /api/public/discord/bot-events
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;       // mesma secret do site
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// IDs das salas que o bot vai monitorar
const CHANNELS = {
  setagem: process.env.CHANNEL_SETAGEM_ID,
  apreensoes: process.env.CHANNEL_APREENCOES_ID,
  ausencia: process.env.CHANNEL_AUSENCIA_ID,
};

// ============ VALIDAÇÃO ============
if (!BOT_TOKEN) { console.error("❌ DISCORD_BOT_TOKEN não definido"); process.exit(1); }
if (!WEBHOOK_URL) { console.error("❌ WEBHOOK_URL não definido"); process.exit(1); }
if (!WEBHOOK_SECRET) { console.error("❌ WEBHOOK_SECRET não definido"); process.exit(1); }

// ============ CLIENT DISCORD ============
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log(`📡 Enviando eventos para: ${WEBHOOK_URL}`);
  console.log(`👁️ Monitorando salas:`, Object.entries(CHANNELS).filter(([,v]) => v).map(([k]) => k));
});

// ============ ENVIAR EVENTO PARA O SITE ============
async function sendToSite(payload) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`❌ Webhook HTTP ${res.status}: ${text}`);
    } else {
      console.log(`✅ Evento enviado: ${payload.type} — ${payload.channel}`);
    }
  } catch (err) {
    console.error("❌ Erro ao enviar webhook:", err.message);
  }
}

// ============ EVENTO: NOVA MENSAGEM ============
client.on("messageCreate", async (message) => {
  // Ignora bots e DM
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== GUILD_ID) return;

  const channelType = Object.entries(CHANNELS).find(([, id]) => id === message.channel.id)?.[0];
  if (!channelType) return; // sala não monitorada

  // Busca cargos do autor (para sala de setagem)
  let roles = [];
  try {
    const member = await message.guild.members.fetch(message.author.id);
    roles = member.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => ({ id: r.id, name: r.name }));
  } catch (e) {
    console.warn("⚠️ Não conseguiu buscar cargos do membro:", e.message);
  }

  const payload = {
    type: channelType,           // "setagem" | "apreensoes" | "ausencia"
    channel: message.channel.name,
    channelId: message.channel.id,
    messageId: message.id,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      avatar: message.author.displayAvatarURL(),
    },
    content: message.content,
    attachments: message.attachments.map((a) => ({ url: a.url, name: a.name })),
    roles, // cargos do Discord (só preenchido em setagem normalmente)
    timestamp: message.createdAt.toISOString(),
  };

  await sendToSite(payload);
});

// ============ EVENTO: MENSAGEM EDITADA ============
client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (newMsg.author?.bot) return;
  if (!newMsg.guild || newMsg.guild.id !== GUILD_ID) return;

  const channelType = Object.entries(CHANNELS).find(([, id]) => id === newMsg.channel.id)?.[0];
  if (!channelType) return;

  await sendToSite({
    type: `${channelType}_edit`,
    channel: newMsg.channel.name,
    channelId: newMsg.channel.id,
    messageId: newMsg.id,
    author: {
      id: newMsg.author.id,
      username: newMsg.author.username,
      displayName: newMsg.author.displayName,
    },
    content: newMsg.content,
    timestamp: newMsg.editedAt?.toISOString() || new Date().toISOString(),
  });
});

// ============ EVENTO: MENSAGEM DELETADA ============
client.on("messageDelete", async (message) => {
  if (!message.guild || message.guild.id !== GUILD_ID) return;

  const channelType = Object.entries(CHANNELS).find(([, id]) => id === message.channel.id)?.[0];
  if (!channelType) return;

  await sendToSite({
    type: `${channelType}_delete`,
    channel: message.channel.name,
    channelId: message.channel.id,
    messageId: message.id,
    timestamp: new Date().toISOString(),
  });
});

// ============ START ============
client.login(BOT_TOKEN);
 
