const { Client, GatewayIntentBits } = require("discord.js");

// ============ CONFIGURAÇÃO ============
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;           // URL do seu site + /api/public/discord/bot-events
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;       // mesma secret do site
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const HIERARCHY_ROLE_IDS = (process.env.HIERARCHY_ROLE_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// IDs das salas que o bot vai monitorar
const CHANNELS = {
  setagem: process.env.CHANNEL_SETAGEM_ID,
  apreensoes: process.env.CHANNEL_APREENCOES_ID,
  ausencia: process.env.CHANNEL_AUSENCIA_ID,
};

// ===== Sala #ponto (Discord da Polícia Cidade Alta) =====
const CHANNEL_PONTO_ID = process.env.CHANNEL_PONTO_ID;
const PONTO_WEBHOOK_URL =
  process.env.PONTO_WEBHOOK_URL ||
  (WEBHOOK_URL ? WEBHOOK_URL.replace(/bot-events\/?$/, "ponto-events") : null);
const PONTO_BACKFILL_LIMIT = Number(process.env.PONTO_BACKFILL_LIMIT || 0); // ex: 5000


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

client.once("clientReady", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log(`📡 Enviando eventos para: ${WEBHOOK_URL}`);
  console.log(`👁️ Monitorando salas:`, Object.entries(CHANNELS).filter(([,v]) => v).map(([k]) => k));
  console.log(`🎖️ Cargos da hierarquia: ${HIERARCHY_ROLE_IDS.length ? HIERARCHY_ROLE_IDS.join(", ") : "todos os cargos"}`);
  if (CHANNEL_PONTO_ID) console.log(`🕒 Monitorando sala de ponto: ${CHANNEL_PONTO_ID} → ${PONTO_WEBHOOK_URL}`);
  console.log(`🏠 Servidores em que o bot está:`, client.guilds.cache.map((g) => `${g.name} (${g.id})`).join(" | ") || "nenhum");
  if (CHANNEL_PONTO_ID) {
    client.channels.fetch(CHANNEL_PONTO_ID)
      .then((ch) => console.log(`✅ Canal de ponto acessível: #${ch?.name} em "${ch?.guild?.name}"`))
      .catch((e) => console.error(`❌ Não consigo acessar o canal de ponto (${CHANNEL_PONTO_ID}): ${e.message}`));
  }
  // Sincroniza membros sem travar o boot do bot
  syncAllMembers().catch((e) => console.error("❌ Sync inicial falhou:", e.message));
  setInterval(() => syncAllMembers().catch((e) => console.error("❌ Sync periódico falhou:", e.message)), 10 * 60 * 1000);
  if (CHANNEL_PONTO_ID && PONTO_BACKFILL_LIMIT > 0) {
    backfillPonto(PONTO_BACKFILL_LIMIT).catch((e) => console.error("❌ Backfill do ponto falhou:", e.message));
  }
});

// ============ PONTO: PARSE E ENVIO ============
const PONTO_RE = /^(.*?)\s*\((\d{1,8})\)\s*=>\s*Data:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\|\s*(ENTRADA|SA[IÍ]DA)\s*:?\s*(\d{1,2}):(\d{1,2}):(\d{1,2})/i;

function saoPauloToUtcIso(d, mo, y, hh, mi, ss) {
  return new Date(Date.UTC(y, mo - 1, d, hh + 3, mi, ss)).toISOString();
}

function parsePontoLine(raw) {
  const line = String(raw || "").replace(/[*_`>]/g, "").replace(/<[^>]+>/g, "").trim();
  const m = line.match(PONTO_RE);
  if (!m) return null;
  const [, name, gameId, dd, mo, yyyy, kind, hh, mi, ss] = m;
  return {
    gameId,
    name: name.replace(/^[^\p{L}\p{N}]+/u, "").trim() || null,
    type: /entrada/i.test(kind) ? "entrada" : "saida",
    occurredAt: saoPauloToUtcIso(+dd, +mo, +yyyy, +hh, +mi, +ss),
  };
}

function extractPontoLines(message) {
  const chunks = [message.content || ""];
  for (const e of message.embeds ?? []) {
    if (e?.description) chunks.push(e.description);
    for (const f of e?.fields ?? []) chunks.push(`${f.name}\n${f.value}`);
  }
  const out = [];
  for (const chunk of chunks) {
    for (const line of String(chunk).split("\n")) {
      const parsed = parsePontoLine(line);
      if (parsed) out.push({ ...parsed, messageId: message.id });
    }
  }
  return out;
}

async function sendPonto(lines, rebuild = false) {
  if (!PONTO_WEBHOOK_URL || (lines.length === 0 && !rebuild)) return;
  try {
    const res = await fetch(PONTO_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": WEBHOOK_SECRET },
      body: JSON.stringify({ type: "ponto", rebuild, lines }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) console.error(`❌ Ponto HTTP ${res.status}: ${text}`);
    else console.log(`🕒 Ponto enviado: ${lines.length} registro(s) — ${text}`);
  } catch (err) {
    console.error("❌ Erro ao enviar ponto:", err.message);
  }
}

client.on("messageCreate", async (message) => {
  if (!CHANNEL_PONTO_ID || message.channel.id !== CHANNEL_PONTO_ID) return;
  const lines = extractPontoLines(message);
  console.log(`🕒 [ponto] mensagem recebida (${message.id}) — ${lines.length} linha(s) reconhecida(s)`);
  if (lines.length === 0) {
    console.log(`🔎 [ponto] conteúdo bruto: ${JSON.stringify(message.content).slice(0, 500)} | embeds: ${(message.embeds || []).length}`);
    return;
  }
  await sendPonto(lines);
});


// A sala #ponto costuma ser atualizada por edição da mesma mensagem
client.on("messageUpdate", async (_old, newMsg) => {
  if (!CHANNEL_PONTO_ID || newMsg.channel?.id !== CHANNEL_PONTO_ID) return;
  try {
    const full = newMsg.partial ? await newMsg.fetch() : newMsg;
    const lines = extractPontoLines(full);
    if (lines.length) await sendPonto(lines);
  } catch (e) {
    console.warn("⚠️ Erro ao processar edição no ponto:", e.message);
  }
});


// Varre o histórico da sala de ponto (em lotes de 100)
async function backfillPonto(limit) {
  const channel = await client.channels.fetch(CHANNEL_PONTO_ID);
  if (!channel) throw new Error("Canal de ponto não encontrado");
  console.log(`🕒 Backfill do ponto iniciado (até ${limit} mensagens)...`);
  let before;
  let scanned = 0;
  let sent = 0;
  while (scanned < limit) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    const lines = [];
    for (const [, msg] of batch) lines.push(...extractPontoLines(msg));
    if (lines.length) {
      // envia em blocos de 500 linhas
      for (let i = 0; i < lines.length; i += 500) {
        await sendPonto(lines.slice(i, i + 500));
        sent += Math.min(500, lines.length - i);
      }
    }
    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  await sendPonto([], true);
  console.log(`✅ Backfill do ponto: ${scanned} mensagens, ${sent} registros enviados`);
}


// ============ SYNC DE MEMBROS DO DISCORD ============
function serializeMember(member, selectedRoleIds = HIERARCHY_ROLE_IDS) {
  const roleList = Array.isArray(member.roles)
    ? member.roles
    : member.roles.cache
        .filter((r) => r.name !== "@everyone")
        .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
  const roles = roleList.sort((a, b) => b.position - a.position);
  const hierarchyRoles = selectedRoleIds.length ? roles.filter((r) => selectedRoleIds.includes(r.id)) : roles;
  if (selectedRoleIds.length && hierarchyRoles.length === 0) return null;
  const top = hierarchyRoles[0] || null;
  return {
    discord_id: member.id,
    username: member.user.username,
    display_name: member.displayName || member.user.global_name || member.user.username,
    avatar_url: member.avatar_url ?? member.user.displayAvatarURL?.({ size: 256 }) ?? null,
    joined_at: member.joinedAt?.toISOString?.() || member.joined_at || null,
    roles,
    top_role_name: top?.name || null,
    top_role_color: top?.color || 0,
    top_role_position: top?.position || 0,
    is_bot: member.user.bot,
  };
}

function discordAvatarUrl(user) {
  if (!user?.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
}

async function discordApiGet(path, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${data?.message || text}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMembersViaRest() {
  console.log(`🔍 Buscando cargos via REST...`);
  const discordRoles = await discordApiGet(`/guilds/${GUILD_ID}/roles`, "roles");
  const roleMap = new Map(discordRoles.map((r) => [r.id, { id: r.id, name: r.name, color: r.color, position: r.position }]));
  const members = [];
  let after = "0";
  let page = 1;
  while (true) {
    console.log(`🔍 Buscando membros via REST — página ${page}...`);
    const query = after === "0" ? "limit=1000" : `limit=1000&after=${after}`;
    const batch = await discordApiGet(`/guilds/${GUILD_ID}/members?${query}`, `members page ${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const member of batch) {
      const roles = (member.roles || []).map((id) => roleMap.get(id)).filter(Boolean);
      members.push({
        id: member.user.id,
        user: member.user,
        displayName: member.nick || member.user.global_name || member.user.username,
        avatar_url: discordAvatarUrl(member.user),
        joined_at: member.joined_at,
        roles,
      });
    }
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
    page += 1;
  }
  return members;
}

async function syncAllMembers() {
  if (!GUILD_ID) throw new Error("DISCORD_GUILD_ID não definido");
  console.log(`🔄 Sincronizando membros do Discord via REST...`);
  const members = await fetchMembersViaRest();
  console.log(`✅ ${members.length} membros recebidos do Discord`);
  const list = members.map((m) => serializeMember(m)).filter(Boolean);
  console.log(`🎖️ ${list.length} membros entraram no filtro da hierarquia`);
  console.log(`🔄 Enviando ${list.length} membros para o site...`);
  await sendToSite({ type: "members_sync", members: list, timestamp: new Date().toISOString() });
  console.log(`✅ Sync concluído`);
}

client.on("guildMemberAdd", async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  await sendToSite({ type: "member_upsert", member: serializeMember(member), timestamp: new Date().toISOString() });
});
client.on("guildMemberUpdate", async (_old, member) => {
  if (member.guild.id !== GUILD_ID) return;
  await sendToSite({ type: "member_upsert", member: serializeMember(member), timestamp: new Date().toISOString() });
});
client.on("guildMemberRemove", async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  await sendToSite({ type: "member_remove", discord_id: member.id, timestamp: new Date().toISOString() });
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

  // Mentions resolvidas (id + nome de exibição)
  const mentions = [];
  try {
    for (const [, u] of message.mentions.users) {
      let displayName = u.username;
      try {
        const mem = await message.guild.members.fetch(u.id);
        displayName = mem.displayName || u.username;
      } catch {}
      mentions.push({ id: u.id, username: u.username, displayName, avatar: u.displayAvatarURL() });
    }
  } catch (e) {
    console.warn("⚠️ Erro ao resolver mentions:", e.message);
  }

  // Coleta imagens: anexos + embeds + URLs no conteúdo
  const collectImages = (msg) => {
    const urls = new Set();
    for (const a of msg.attachments?.values?.() ?? []) {
      if (a?.url) urls.add(JSON.stringify({ url: a.url, proxy_url: a.proxyURL, content_type: a.contentType, filename: a.name }));
    }
    for (const e of msg.embeds ?? []) {
      if (e?.image?.url) urls.add(e.image.url);
      if (e?.thumbnail?.url) urls.add(e.thumbnail.url);
      if (e?.url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(e.url)) urls.add(e.url);
    }
    const re = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?)/gi;
    let m;
    while ((m = re.exec(msg.content || "")) !== null) urls.add(m[1]);
    return Array.from(urls).map((item) => {
      try { return JSON.parse(item); } catch { return { url: item }; }
    });
  };

  const payload = {
    type: channelType,
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
    attachments: collectImages(message),
    mentions,
    roles,
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

  // Resolve mentions (igual ao messageCreate) para não perder participantes ao editar
  const mentions = [];
  try {
    for (const [, u] of newMsg.mentions.users) {
      let displayName = u.username;
      try {
        const mem = await newMsg.guild.members.fetch(u.id);
        displayName = mem.displayName || u.username;
      } catch {}
      mentions.push({ id: u.id, username: u.username, displayName, avatar: u.displayAvatarURL() });
    }
  } catch (e) {
    console.warn("⚠️ Erro ao resolver mentions (edit):", e.message);
  }

  await sendToSite({
    type: `${channelType}_edit`,
    channel: newMsg.channel.name,
    channelId: newMsg.channel.id,
    messageId: newMsg.id,
    author: {
      id: newMsg.author.id,
      username: newMsg.author.username,
      displayName: newMsg.author.displayName,
      avatar: newMsg.author.displayAvatarURL?.(),
    },
    content: newMsg.content,
    attachments: (() => {
      const urls = new Set();
      for (const a of newMsg.attachments?.values?.() ?? []) {
        if (a?.url) urls.add(JSON.stringify({ url: a.url, proxy_url: a.proxyURL, content_type: a.contentType, filename: a.name }));
      }
      for (const e of newMsg.embeds ?? []) {
        if (e?.image?.url) urls.add(e.image.url);
        if (e?.thumbnail?.url) urls.add(e.thumbnail.url);
        if (e?.url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(e.url)) urls.add(e.url);
      }
      const re = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?)/gi;
      let m; while ((m = re.exec(newMsg.content || "")) !== null) urls.add(m[1]);
      return Array.from(urls).map((item) => {
        try { return JSON.parse(item); } catch { return { url: item }; }
      });
    })(),
    mentions,
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
