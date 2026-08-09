const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const http = require("http");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "s";
const HELP_IMAGE_URL = "https://cdn.discordapp.com/attachments/1530810108899233845/1535967481196453969/file_0000000004808211a3a74b96ae281da2.png?ex=6a79b0b0&is=6a785f30&hm=b133c50089e6dbac857c1e543e52d477c15bf1c12b7c5c20e404e76f8e4327&";
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_API_URL = process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN environment variable.");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULTS = {
  warnings: {},
  antiLink: {},
  blockedWords: {},
  autoReactions: {},
  autoRoles: {},
  aiChannels: {},
  embeds: {},
  snipes: {},
  linkStrikes: {},
  wordStrikes: {},
  aiHistory: {}
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function loadDB() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...cloneDefaults(), ...parsed };
  } catch {
    return cloneDefaults();
  }
}

let db = loadDB();

function saveDB() {
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("[DB] save failed:", err);
  }
}

function pinkYellow() {
  return 0xF0A6FF;
}

function makeEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(pinkYellow())
    .setTitle(title)
    .setDescription(description || "Done.")
    .setTimestamp();
}

async function sendEmbed(msg, title, description, extra = {}) {
  const e = makeEmbed(title, description);
  if (extra.image) e.setImage(extra.image);
  if (extra.thumbnail) e.setThumbnail(extra.thumbnail);
  if (extra.footer) e.setFooter({ text: extra.footer });
  return msg.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
}

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function hasManageGuild(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    isAdmin(member);
}

function hasManageMessages(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.ManageMessages) ||
    isAdmin(member);
}

function cleanId(value = "") {
  return String(value).replace(/[<@!&#>]/g, "");
}

function getMember(guild, input) {
  if (!input) return null;
  const id = cleanId(input);
  return guild.members.cache.get(id) ||
    guild.members.cache.find(m => m.user.username.toLowerCase() === String(input).toLowerCase()) ||
    guild.members.cache.find(m => m.displayName.toLowerCase() === String(input).toLowerCase()) ||
    null;
}

function canTarget(actor, target) {
  if (!target || target.id === actor.id) return false;
  if (target.id === actor.guild.ownerId) return false;
  return target.roles.highest.position < actor.roles.highest.position;
}

function botCanTarget(guild, target) {
  const me = guild.members.me;
  if (!me || !target) return false;
  return target.roles.highest.position < me.roles.highest.position;
}

function parseDuration(value) {
  if (!value) return null;
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(value).trim());
  if (!m) return null;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const ms = Number(m[1]) * units[m[2].toLowerCase()];
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, 28 * 86400000);
}

function isUrl(text) {
  return /https?:\/\/[^\s]+|www\.[^\s]+|(?:discord\.gg|discord\.com\/invite)\/[^\s]+/i.test(text);
}

function isAllowedGifUrl(url) {
  const clean = url.replace(/[)>.,!?]+$/g, "");
  return /\.(gif)(?:\?.*)?$/i.test(clean) ||
    /(?:giphy\.com|tenor\.com)\//i.test(clean);
}

function allUrlsAreAllowedGifs(text) {
  const urls = text.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) || [];
  if (!urls.length) return false;
  return urls.every(isAllowedGifUrl);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactWord(text, word) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(word)}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function normalizeWord(word) {
  return String(word || "").trim().toLowerCase();
}

function getMentionedChannel(msg, value) {
  return msg.mentions.channels.first() ||
    msg.guild.channels.cache.get(cleanId(value)) ||
    null;
}

function getMentionedRole(msg, value) {
  return msg.mentions.roles.first() ||
    msg.guild.roles.cache.get(cleanId(value)) ||
    null;
}

function getMentionedUser(msg, value) {
  return msg.mentions.users.first() ||
    msg.guild.members.cache.get(cleanId(value))?.user ||
    null;
}

function ensureGuild(obj, guildId, fallback) {
  if (obj[guildId] === undefined) obj[guildId] = fallback;
  return obj[guildId];
}

function addSnipe(guildId, item) {
  db.snipes[guildId] ||= [];
  db.snipes[guildId].unshift(item);
  db.snipes[guildId] = db.snipes[guildId].slice(0, 20);
}

async function botCanSend(channel) {
  const me = channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return !!perms?.has(PermissionsBitField.Flags.SendMessages) &&
    !!perms?.has(PermissionsBitField.Flags.EmbedLinks);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

/* ---------- AI ---------- */

function aiEnabled(guildId, channelId) {
  return (db.aiChannels[guildId] || []).includes(channelId);
}

async function askAI(guildId, channelId, userName, userMessage) {
  if (!AI_API_KEY) return null;

  db.aiHistory[guildId] ||= {};
  db.aiHistory[guildId][channelId] ||= [];
  const history = db.aiHistory[guildId][channelId];

  const system = {
    role: "system",
    content:
      "You are Shinra Katsumi, a Discord server assistant. " +
      "Your personality is playful, chill, cheerful, slightly mischievous and childish-but-mature. " +
      "Be natural and conversational, not repetitive or robotic. Understand and reply in the language the user uses, including Hinglish and common multilingual chat. " +
      "You can joke and tease lightly, but never produce sexual or explicit content. " +
      "Keep replies suitable for a teen-friendly Discord server. " +
      "Do not claim to be human. Keep most replies concise unless the user asks for detail."
  };

  const messages = [
    system,
    ...history.slice(-12),
    { role: "user", content: `${userName}: ${userMessage}` }
  ];

  try {
    const response = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0.85,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("[AI] API error:", response.status, body.slice(0, 1000));
      return null;
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return null;

    history.push(
      { role: "user", content: `${userName}: ${userMessage}` },
      { role: "assistant", content: answer }
    );
    db.aiHistory[guildId][channelId] = history.slice(-20);
    saveDB();
    return answer;
  } catch (err) {
    console.error("[AI] request failed:", err);
    return null;
  }
}

/* ---------- Ready / persistence ---------- */

client.once("ready", () => {
  client.user.setPresence({
    activities: [{ name: "love you kitaryo senpai 💕" }],
    status: "online"
  });
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Prefix commands: s / S");
  console.log(`AI configured: ${AI_API_KEY ? "yes" : "no (set AI_API_KEY on Render)"}`);
});

/* ---------- Auto role ---------- */

client.on("guildMemberAdd", async member => {
  const roleIds = db.autoRoles[member.guild.id] || [];
  for (const id of roleIds) {
    const role = member.guild.roles.cache.get(id);
    if (!role) continue;
    if (!member.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) continue;
    if (role.position >= member.guild.members.me.roles.highest.position) continue;
    await member.roles.add(role, "Auto role").catch(() => {});
  }
});

/* ---------- Snipe ---------- */

client.on("messageDelete", async msg => {
  if (!msg.guild || !msg.author || msg.author.bot) return;
  addSnipe(msg.guild.id, {
    type: "deleted",
    authorId: msg.author.id,
    authorTag: msg.author.tag,
    content: msg.content || "(no text)",
    attachments: [...msg.attachments.values()].map(a => a.url),
    channelId: msg.channel.id,
    time: Date.now()
  });
  saveDB();
});

client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (!newMsg.guild || !newMsg.author || newMsg.author.bot) return;
  if (oldMsg.content === newMsg.content) return;
  addSnipe(newMsg.guild.id, {
    type: "edited",
    authorId: newMsg.author.id,
    authorTag: newMsg.author.tag,
    content: `Before: ${oldMsg.content || "(no text)"}\nAfter: ${newMsg.content || "(no text)"}`,
    attachments: [],
    channelId: newMsg.channel.id,
    time: Date.now()
  });
  saveDB();
});

/* ---------- Message handler ---------- */

client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;

  // Anti-link filter.
  const antiLinkOn = !!db.antiLink[msg.guild.id];
  if (antiLinkOn && !isAdmin(msg.member) && isUrl(msg.content) && !allUrlsAreAllowedGifs(msg.content)) {
    await msg.delete().catch(() => {});
    const k = `${msg.guild.id}:${msg.author.id}`;
    db.linkStrikes[k] = (db.linkStrikes[k] || 0) + 1;

    if (db.linkStrikes[k] >= 3) {
      await msg.member.timeout(60 * 60 * 1000, "Anti-link: 3 consecutive violations").catch(() => {});
      db.linkStrikes[k] = 0;
      await sendEmbed(msg, "Anti-link", `${msg.author} was timed out for **1 hour** after 3 link violations.`).catch(() => {});
    }
    saveDB();
    return;
  } else if (antiLinkOn && !isAdmin(msg.member)) {
    db.linkStrikes[`${msg.guild.id}:${msg.author.id}`] = 0;
  }

  // Blocked word filter.
  const blocked = db.blockedWords[msg.guild.id] || [];
  const hit = blocked.find(word => exactWord(msg.content, word));
  if (hit && !isAdmin(msg.member)) {
    await msg.delete().catch(() => {});
    const k = `${msg.guild.id}:${msg.author.id}`;
    db.wordStrikes[k] = (db.wordStrikes[k] || 0) + 1;

    if (db.wordStrikes[k] >= 3) {
      await msg.member.timeout(30 * 60 * 1000, "Blocked word: 3 consecutive violations").catch(() => {});
      db.wordStrikes[k] = 0;
      await sendEmbed(msg, "Blocked word", `${msg.author} was timed out for **30 minutes** after 3 blocked-word violations.`).catch(() => {});
    }
    saveDB();
    return;
  } else if (blocked.length && !isAdmin(msg.member)) {
    db.wordStrikes[`${msg.guild.id}:${msg.author.id}`] = 0;
  }

  // Auto reaction.
  const ar = db.autoReactions[msg.guild.id]?.[msg.channel.id];
  if (ar && exactWord(msg.content, ar.word)) {
    await msg.react(ar.emoji).catch(() => {});
  }

  // AI: in an enabled channel, reply to normal messages; also responds to mentions/replies.
  if (aiEnabled(msg.guild.id, msg.channel.id)) {
    const reference = msg.reference?.messageId
      ? await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null)
      : null;
    const mentioned = msg.mentions.has(client.user);
    const replyingToBot = reference?.author?.id === client.user.id;

    // Ignore messages that are only a prefix command.
    if (!/^s(?:\s|$)/i.test(msg.content) && (msg.content.trim().length > 0 || mentioned || replyingToBot)) {
      const cleaned = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      const answer = await askAI(msg.guild.id, msg.channel.id, msg.member.displayName, cleaned || "You were mentioned.");
      if (answer) {
        await msg.reply({ content: answer.slice(0, 1900), allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    }
  }

  // Strict prefix: only "s" or "S" at the start followed by whitespace/end.
  if (!/^s(?:\s|$)/i.test(msg.content)) return;

  const body = msg.content.replace(/^s\s*/i, "").trim();
  if (!body) return;

  const args = body.split(/\s+/).filter(Boolean);
  const cmd = (args.shift() || "").toLowerCase();
  if (!cmd) return;

  await runCommand(msg, cmd, args);
});

/* ---------- Command helpers ---------- */

function requireManageGuild(msg) {
  if (!hasManageGuild(msg.member)) {
    sendEmbed(msg, "Permission denied", "You need **Manage Server** or **Administrator**.");
    return false;
  }
  return true;
}

function requireManageMessages(msg) {
  if (!hasManageMessages(msg.member)) {
    sendEmbed(msg, "Permission denied", "You need **Manage Messages** or **Administrator**.");
    return false;
  }
  return true;
}

function getAvatarUrl(user) {
  return user.displayAvatarURL({ extension: "png", size: 1024, forceStatic: false });
}

/* ---------- Embed builder ---------- */

function getDraft(guildId, userId, channelId) {
  db.embeds[guildId] ||= {};
  const key = `${userId}:${channelId}`;
  db.embeds[guildId][key] ||= {
    title: "",
    description: "",
    thumbnail: "",
    footer: "",
    image: "",
    color: "F0A6FF",
    channelId
  };
  return db.embeds[guildId][key];
}

function draftEmbed(draft) {
  const e = new EmbedBuilder().setColor(Number.parseInt(draft.color || "F0A6FF", 16));
  if (draft.title) e.setTitle(draft.title.slice(0, 256));
  if (draft.description) e.setDescription(draft.description.slice(0, 4096));
  if (draft.thumbnail) e.setThumbnail(draft.thumbnail);
  if (draft.image) e.setImage(draft.image);
  if (draft.footer) e.setFooter({ text: draft.footer.slice(0, 2048) });
  return e;
}

async function handleEmbed(msg, args) {
  if (!requireManageGuild(msg)) return;

  const action = (args[0] || "").toLowerCase();
  const draft = getDraft(msg.guild.id, msg.author.id, msg.channel.id);

  if (!action) {
    return sendEmbed(
      msg,
      "Embed Builder",
      [
        "**Current draft**",
        `Title: ${draft.title || "—"}`,
        `Description: ${draft.description || "—"}`,
        `Thumbnail: ${draft.thumbnail ? "set" : "—"}`,
        `Footer: ${draft.footer || "—"}`,
        `Image: ${draft.image ? "set" : "—"}`,
        `Color: #${draft.color}`,
        `Channel: <#${draft.channelId}>`,
        "",
        "**Commands**",
        "`s embed title <text>`",
        "`s embed description <text>`",
        "`s embed thumbnail <url>`",
        "`s embed footer <text>`",
        "`s embed image <url>`",
        "`s embed color <hex>`",
        "`s embed channel #channel`",
        "`s embed clear`",
        "`s embed send`"
      ].join("\n")
    );
  }

  const value = args.slice(1).join(" ").trim();

  if (action === "title") draft.title = value;
  else if (action === "description" || action === "desc") draft.description = value;
  else if (action === "thumbnail" || action === "thumb") draft.thumbnail = value;
  else if (action === "footer") draft.footer = value;
  else if (action === "image") draft.image = value;
  else if (action === "color" || action === "colour") {
    const color = value.replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(color)) return sendEmbed(msg, "Embed Builder", "Color must be a 6-digit hex value, e.g. `FF69B4`.");
    draft.color = color.toUpperCase();
  } else if (action === "channel") {
    const channel = getMentionedChannel(msg, args[1]);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      return sendEmbed(msg, "Embed Builder", "Mention a text channel, e.g. `s embed channel #general`.");
    }
    draft.channelId = channel.id;
  } else if (action === "clear") {
    db.embeds[msg.guild.id][`${msg.author.id}:${msg.channel.id}`] = {
      title: "", description: "", thumbnail: "", footer: "", image: "",
      color: "F0A6FF", channelId: msg.channel.id
    };
  } else if (action === "send") {
    const channel = msg.guild.channels.cache.get(draft.channelId);
    if (!channel || !channel.isTextBased()) return sendEmbed(msg, "Embed Builder", "Selected channel no longer exists.");
    const me = msg.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages | PermissionsBitField.Flags.EmbedLinks)) {
      return sendEmbed(msg, "Embed Builder", "I cannot send embeds in the selected channel.");
    }
    await channel.send({ embeds: [draftEmbed(draft)] });
    return sendEmbed(msg, "Embed Builder", `Embed sent to ${channel}.`);
  } else {
    return sendEmbed(msg, "Embed Builder", "Unknown builder action. Use `s embed` to see the panel.");
  }

  saveDB();
  return sendEmbed(msg, "Embed Builder", `Updated **${action}**. Use \`s embed\` to view the current panel.`);
}

/* ---------- Commands ---------- */

async function runCommand(msg, cmd, args) {
  const g = msg.guild;
  const member = msg.member;

  try {
    if (cmd === "help") {
      const e = new EmbedBuilder()
        .setColor(pinkYellow())
        .setTitle("Shinra Katsumi • Help Menu")
        .setDescription([
          "**🛡️ Moderation**",
          "`s purge <number|all>` — Delete messages.",
          "`s kick @user` — Kick a member.",
          "`s ban @user` — Ban a member.",
          "`s timeout @user <time>` — Timeout a member.",
          "`s mute <time> @user` — Mute using timeout.",
          "`s unmute @user` — Remove timeout.",
          "`s warn @user [reason]` — Add warning.",
          "`s cw @user` — Clear warnings.",
          "`s cl @user` — List warnings.",
          "`s snipe` — Show recent deleted/edited messages.",
          "",
          "**🔒 Channel / Roles**",
          "`s lock` / `s unlock` — Lock/unlock channel.",
          "`s role add @user @role` — Add role.",
          "`s role remove @user @role` — Remove role.",
          "`s autorole add @role` — Join role.",
          "`s autorole remove @role` — Remove join role.",
          "`s si` — Server information.",
          "`s av [@user]` — Show avatar.",
          "",
          "**🚫 Filters / Automation**",
          "`s antilink enable|disable` — All-channel link filter.",
          "`s bd add <word>` — Add blocked word.",
          "`s bd remove <word>` — Remove blocked word.",
          "`s bd list` — List blocked words.",
          "`s ar #channel <word> <emoji>` — Auto reaction.",
          "`s ar remove #channel` — Remove auto reaction.",
          "",
          "**✨ Embed / AI**",
          "`s embed` — Open embed builder.",
          "`s ai enable` — Enable AI in this channel.",
          "`s ai disable` — Disable AI in this channel.",
          "",
          "**Prefix:** `s` or `S` only."
        ].join("\n"))
        .setImage(HELP_IMAGE_URL)
        .setFooter({ text: "Kitaryo • Prefix commands only" })
        .setTimestamp();
      return msg.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
    }

    if (cmd === "purge") {
      if (!requireManageMessages(msg)) return;
      if (!msg.channel.isTextBased() || !msg.channel.bulkDelete) return sendEmbed(msg, "Purge", "This channel does not support bulk delete.");
      const amount = String(args[0] || "").toLowerCase();
      if (amount === "all") {
        let total = 0;
        for (let i = 0; i < 20; i++) {
          const batch = await msg.channel.bulkDelete(100, true).catch(() => null);
          if (!batch || batch.size === 0) break;
          total += batch.size;
          if (batch.size < 100) break;
        }
        return sendEmbed(msg, "Purge", `Deleted **${total}** messages.`);
      }
      const n = Math.min(Math.max(Number.parseInt(amount, 10) || 0, 1), 100);
      const deleted = await msg.channel.bulkDelete(n, true);
      return sendEmbed(msg, "Purge", `Deleted **${deleted.size}** messages.`);
    }

    if (cmd === "kick" || cmd === "ban") {
      if (!requireManageGuild(msg)) return;
      const target = getMember(g, args[0]);
      if (!canTarget(member, target) || !botCanTarget(g, target)) return sendEmbed(msg, "Action blocked", "I cannot moderate that member. Check role hierarchy.");
      if (cmd === "kick") {
        await target.kick("Kitaryo moderation command");
        return sendEmbed(msg, "Kick", `**${target.user.tag}** was kicked.`);
      }
      await target.ban({ reason: "Kitaryo moderation command" });
      return sendEmbed(msg, "Ban", `**${target.user.tag}** was banned.`);
    }

    if (cmd === "av" || cmd === "avatar") {
      const user = msg.mentions.users.first() ||
        (args[0] ? g.members.cache.get(cleanId(args[0]))?.user : null) ||
        msg.author;
      const url = getAvatarUrl(user);
      const e = makeEmbed("Avatar", `${user} • [Open avatar](${url})`).setImage(url);
      return msg.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
    }

    if (cmd === "timeout" || cmd === "mute") {
      if (!requireManageGuild(msg)) return;
      let target = null;
      let duration = null;
      let durationText = null;

      if (parseDuration(args[0])) {
        durationText = args[0];
        duration = parseDuration(args[0]);
        target = getMember(g, args[1]);
      } else {
        target = getMember(g, args[0]);
        durationText = args[1];
        duration = parseDuration(args[1]);
      }

      if (!target || !duration) return sendEmbed(msg, "Mute", "Use `s mute 1h @user` or `s mute @user 1h`.");
      if (!canTarget(member, target) || !botCanTarget(g, target)) return sendEmbed(msg, "Action blocked", "I cannot timeout that member. Check role hierarchy.");
      await target.timeout(duration, "Kitaryo moderation command");
      return sendEmbed(msg, "Timeout", `**${target.user.tag}** timed out for **${durationText}**.`);
    }

    if (cmd === "unmute") {
      if (!requireManageGuild(msg)) return;
      const target = getMember(g, args[0]);
      if (!canTarget(member, target) || !botCanTarget(g, target)) return sendEmbed(msg, "Action blocked", "I cannot modify that member.");
      await target.timeout(null, "Kitaryo unmute command");
      return sendEmbed(msg, "Unmute", `**${target.user.tag}** is no longer timed out.`);
    }

    if (cmd === "warn") {
      if (!requireManageGuild(msg)) return;
      const target = getMember(g, args[0]);
      if (!canTarget(member, target)) return sendEmbed(msg, "Action blocked", "I cannot warn that member.");
      const reason = args.slice(1).join(" ") || "No reason given";
      db.warnings[g.id] ||= {};
      db.warnings[g.id][target.id] ||= [];
      db.warnings[g.id][target.id].push({ reason, by: msg.author.id, time: Date.now() });
      saveDB();
      return sendEmbed(msg, "Warning", `**${target.user.tag}** received a warning.\n**Reason:** ${reason}`);
    }

    if (cmd === "cw" || cmd === "cl") {
      if (!requireManageGuild(msg)) return;
      const target = getMember(g, args[0]);
      if (!target) return sendEmbed(msg, "Warnings", "Mention a member.");
      db.warnings[g.id] ||= {};
      db.warnings[g.id][target.id] ||= [];

      if (cmd === "cw") {
        db.warnings[g.id][target.id] = [];
        saveDB();
        return sendEmbed(msg, "Warnings cleared", `All warnings for **${target.user.tag}** were cleared.`);
      }

      const list = db.warnings[g.id][target.id];
      return sendEmbed(msg, "Warning list", list.length
        ? list.map((w, i) => `**${i + 1}.** ${w.reason}`).join("\n")
        : "No warnings.");
    }

    if (cmd === "snipe") {
      const list = db.snipes[g.id] || [];
      if (!list.length) return sendEmbed(msg, "Snipe", "Nothing to snipe.");
      const lines = list.slice(0, 20).map((s, i) =>
        `**${i + 1}. ${s.type.toUpperCase()}** • <@${s.authorId}> • <#${s.channelId}>\n${s.content.slice(0, 300)}`
      );
      return sendEmbed(msg, "Snipe • Last 20", lines.join("\n\n"));
    }

    if (cmd === "lock" || cmd === "unlock") {
      if (!requireManageGuild(msg)) return;
      const everyone = g.roles.everyone;
      await msg.channel.permissionOverwrites.edit(everyone, {
        SendMessages: cmd === "unlock"
      });
      return sendEmbed(msg, cmd === "lock" ? "Channel locked" : "Channel unlocked",
        `${msg.channel} was updated.`);
    }

    if (cmd === "role") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      const target = getMember(g, args[1]);
      const role = getMentionedRole(msg, args[2]);
      if (!["add", "remove"].includes(action) || !target || !role) {
        return sendEmbed(msg, "Role", "Use `s role add @user @role` or `s role remove @user @role`.");
      }
      if (role.position >= g.members.me.roles.highest.position) return sendEmbed(msg, "Role blocked", "That role is above my highest role.");
      if (role.managed) return sendEmbed(msg, "Role blocked", "Managed roles cannot be assigned.");
      if (action === "add") await target.roles.add(role, "Kitaryo role command");
      else await target.roles.remove(role, "Kitaryo role command");
      return sendEmbed(msg, "Role updated", `**${role.name}** ${action}ed for **${target.user.tag}**.`);
    }

    if (cmd === "si") {
      return sendEmbed(msg, "Server Information",
        `**Name:** ${g.name}\n**ID:** ${g.id}\n**Members:** ${g.memberCount}\n**Channels:** ${g.channels.cache.size}\n**Roles:** ${g.roles.cache.size}\n**Owner:** <@${g.ownerId}>`);
    }

    if (cmd === "antilink") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      if (!["enable", "disable"].includes(action)) return sendEmbed(msg, "Anti-link", "Use `s antilink enable` or `s antilink disable`.");
      db.antiLink[g.id] = action === "enable";
      saveDB();
      return sendEmbed(msg, "Anti-link", action === "enable"
        ? "Enabled **server-wide**. Normal links are deleted; GIF links are allowed; administrators are exempt. 3 consecutive violations = 1 hour timeout."
        : "Disabled server-wide.");
    }

    if (cmd === "bd") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      db.blockedWords[g.id] ||= [];

      if (action === "list") {
        return sendEmbed(msg, "Blocked words", db.blockedWords[g.id].length
          ? db.blockedWords[g.id].map((w, i) => `${i + 1}. \`${w}\``).join("\n")
          : "No blocked words.");
      }

      const word = normalizeWord(args.slice(1).join(" "));
      if (!word) return sendEmbed(msg, "Blocked words", "Use `s bd add <word>` or `s bd remove <word>`.");

      if (action === "add") {
        if (!db.blockedWords[g.id].includes(word)) db.blockedWords[g.id].push(word);
        else return sendEmbed(msg, "Blocked words", "That word is already blocked.");
      } else if (action === "remove") {
        db.blockedWords[g.id] = db.blockedWords[g.id].filter(w => w !== word);
      } else {
        return sendEmbed(msg, "Blocked words", "Use `add`, `remove`, or `list`.");
      }

      saveDB();
      return sendEmbed(msg, "Blocked words", `**${action}**: \`${word}\``);
    }

    if (cmd === "ar") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      db.autoReactions[g.id] ||= {};

      if (action === "remove") {
        const channel = getMentionedChannel(msg, args[1]);
        if (!channel) return sendEmbed(msg, "Auto reaction", "Use `s ar remove #channel`.");
        delete db.autoReactions[g.id][channel.id];
        saveDB();
        return sendEmbed(msg, "Auto reaction", `Removed from ${channel}.`);
      }

      const channel = getMentionedChannel(msg, args[0]);
      const word = args[1];
      const emoji = args.slice(2).join(" ");
      if (!channel || !word || !emoji) return sendEmbed(msg, "Auto reaction", "Use `s ar #channel word emoji`.");
      db.autoReactions[g.id][channel.id] = { word: normalizeWord(word), emoji };
      saveDB();
      return sendEmbed(msg, "Auto reaction", `When **${word}** appears in ${channel}, I will react with ${emoji}.`);
    }

    if (cmd === "autorole") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      const role = getMentionedRole(msg, args[1]);
      if (!role || !["add", "remove"].includes(action)) return sendEmbed(msg, "Auto role", "Use `s autorole add @role` or `s autorole remove @role`.");
      db.autoRoles[g.id] ||= [];

      if (action === "add") {
        if (!db.autoRoles[g.id].includes(role.id)) db.autoRoles[g.id].push(role.id);
      } else {
        db.autoRoles[g.id] = db.autoRoles[g.id].filter(id => id !== role.id);
      }

      saveDB();
      return sendEmbed(msg, "Auto role", `${action === "add" ? "Added" : "Removed"} **${role.name}**.`);
    }

    if (cmd === "embed") return handleEmbed(msg, args);

    if (cmd === "ai") {
      if (!requireManageGuild(msg)) return;
      const action = String(args[0] || "").toLowerCase();
      db.aiChannels[g.id] ||= [];

      if (action === "enable") {
        if (!AI_API_KEY) return sendEmbed(msg, "AI mode", "AI API key is not configured. Add `AI_API_KEY` in Render Environment Variables.");
        if (!db.aiChannels[g.id].includes(msg.channel.id)) db.aiChannels[g.id].push(msg.channel.id);
        db.aiHistory[g.id] ||= {};
        db.aiHistory[g.id][msg.channel.id] ||= [];
      } else if (action === "disable") {
        db.aiChannels[g.id] = db.aiChannels[g.id].filter(id => id !== msg.channel.id);
      } else {
        return sendEmbed(msg, "AI mode", "Use `s ai enable` or `s ai disable`.");
      }

      saveDB();
      return sendEmbed(msg, "AI mode", action === "enable"
        ? `AI is now **enabled** in ${msg.channel}. I will respond to normal messages there.`
        : `AI is now **disabled** in ${msg.channel}.`);
    }

    return sendEmbed(msg, "Unknown command", "Use `s help`.");
  } catch (err) {
    console.error(`[COMMAND ${cmd}]`, err?.stack || err);
    return sendEmbed(msg, "Error", "The command could not be completed. Check the command format and bot permissions.");
  }
}

/* ---------- Render health server ---------- */

const PORT = Number(process.env.PORT || 10000);
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Kitaryo Discord Bot is online.\n");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[Render] HTTP health server listening on port ${PORT}`);
});

process.on("unhandledRejection", err => console.error("[Unhandled rejection]", err?.stack || err));
process.on("uncaughtException", err => console.error("[Uncaught exception]", err?.stack || err));

client.login(TOKEN).catch(err => {
  console.error("[Login failed]", err?.stack || err);
  process.exit(1);
});
