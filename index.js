const {
  Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder,
  Collection, REST, Routes, SlashCommandBuilder
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "s";
if (!TOKEN) throw new Error("Missing DISCORD_TOKEN environment variable.");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "data.json");

const defaults = {
  warnings: {}, antiLink: {}, blockedWords: {}, autoReactions: {},
  autoRoles: {}, aiChannels: {}, embeds: {}, snipes: {}, linkStrikes: {}, wordStrikes: {}
};
let db = loadDB();

function loadDB() {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; }
  catch { return structuredClone(defaults); }
}
function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function key(guildId, extra="") { return `${guildId}:${extra}`; }
function yellowPink() {
  return 0xF0A6FF;
}
function embed(title, description) {
  return new EmbedBuilder().setColor(yellowPink()).setTitle(title).setDescription(description || "Done.").setTimestamp();
}
async function reply(ctx, title, description, ephemeral=false) {
  const e = embed(title, description);
  if (ctx.reply) return ctx.reply({ embeds:[e], ephemeral });
}
function isAdmin(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}
function canModerate(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
         member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}
function cleanId(s) { return s?.replace(/[<@!&#>]/g, "") || ""; }
function parseDuration(s) {
  if (!s) return null;
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(s);
  if (!m) return null;
  return Math.min(Number(m[1]) * ({s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]), 28*86400000);
}
function getMember(guild, input) {
  const id = cleanId(input);
  return guild.members.cache.get(id) || guild.members.cache.find(m => m.user.username.toLowerCase() === String(input).toLowerCase());
}
function canTarget(actor, target) {
  return target && target.id !== actor.id && target.roles.highest.position < actor.roles.highest.position;
}
function isLink(text) {
  return /(https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/)/i.test(text);
}
function isGifOnlyAllowed(text) {
  return /\.(gif)(\?.*)?$/i.test(text.trim());
}
function normalizeWord(s) { return s.trim().toLowerCase(); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

  }
}

client.once("ready", () => {
  client.user.setPresence({ activities:[{name:"love you kitaryo senpai 💕"}], status:"online" });
  console.log(`Logged in as ${client.user.tag}`);
});


client.on("guildMemberAdd", async member => {
  const roles = db.autoRoles[member.guild.id] || [];
  for (const id of roles) {
    const role = member.guild.roles.cache.get(id);
    if (role) await member.roles.add(role).catch(()=>{});
  }
});

client.on("messageDelete", async msg => {
  if (!msg.guild || msg.author?.bot) return;
  const k = msg.guild.id;
  db.snipes[k] = { type:"deleted", author:msg.author.tag, content:msg.content || "(no text)", time:Date.now() };
  saveDB();
});
client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot || oldMsg.content === newMsg.content) return;
  db.snipes[newMsg.guild.id] = { type:"edited", author:newMsg.author.tag, content:`Before: ${oldMsg.content}\nAfter: ${newMsg.content}`, time:Date.now() };
  saveDB();
});

client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;

  // Anti-link: administrators are exempt; GIF links are allowed.
  if (!isAdmin(msg.member) && db.antiLink[msg.guild.id] && isLink(msg.content) && !isGifOnlyAllowed(msg.content)) {
    await msg.delete().catch(()=>{});
    const k = key(msg.guild.id, msg.author.id);
    db.linkStrikes[k] = (db.linkStrikes[k] || 0) + 1;
    if (db.linkStrikes[k] >= 3) {
      await msg.member.timeout(60*60*1000, "Anti-link: 3 link violations").catch(()=>{});
      db.linkStrikes[k] = 0;
    }
    saveDB();
    return;
  }

  // Blocked words: exact word match, case-insensitive.
  const words = db.blockedWords[msg.guild.id] || [];
  const hit = words.find(w => new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=\\W|$)`, "i").test(msg.content));
  if (hit && !isAdmin(msg.member)) {
    await msg.delete().catch(()=>{});
    const k = key(msg.guild.id, msg.author.id);
    db.wordStrikes[k] = (db.wordStrikes[k] || 0) + 1;
    if (db.wordStrikes[k] >= 3) {
      await msg.member.timeout(30*60*1000, "Blocked-word: 3 violations").catch(()=>{});
      db.wordStrikes[k] = 0;
    }
    saveDB();
    return;
  }

  // Auto reactions.
  const ars = db.autoReactions[msg.guild.id] || {};
  const cfg = ars[msg.channel.id];
  if (cfg && new RegExp(`(^|\\W)${cfg.word.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=\\W|$)`, "i").test(msg.content)) {
    const emoji = cfg.emoji;
    await msg.react(emoji).catch(()=>{});
  }

  // Mention/reply AI mode: safe, lightweight local responses; no external API required.
  const aiOn = db.aiChannels[msg.guild.id]?.includes(msg.channel.id);
  if (aiOn && (msg.mentions.has(client.user) || (msg.reference && (await msg.fetchReference().catch(()=>null))?.author?.id === client.user.id))) {
    const replies = [
      "Hii ✨ what’s up?",
      "Hehe, I’m here! Tell me what you need 💕",
      "Got you 😌",
      "Okii! Let’s do it ✨",
      "I’m listening 👀"
    ];
    await msg.reply(replies[Math.floor(Math.random()*replies.length)]);
  }

  if (!msg.content.toLowerCase().startsWith(PREFIX)) return;
  const args = msg.content.trim().split(/\s+/);
  const cmd = args.shift().slice(1).toLowerCase();
  await runCommand(msg, cmd, args);
});

async function runCommand(msg, cmd, args) {
  const g = msg.guild, member = msg.member;
  const adminOnly = ["kick","ban","timeout","warn","cw","lock","unlock","antilink","bd","ar","autorole","embed","ai"];
  if (adminOnly.includes(cmd) && !canModerate(member)) return reply(msg,"Permission denied","You need Manage Server or Administrator.");
  try {
    if (cmd === "help") {
      const pages = [
        "**Moderation**\n`s purge <number|all>` — Delete messages.\n`s kick @user` — Kick.\n`s ban @user` — Ban.\n`s timeout @user <time>` — Timeout.\n`s mute @user <time>` — Alias of timeout.\n`s unmute @user` — Remove timeout.\n`s warn @user [reason]` — Warn.\n`s cw @user` — Clear warnings.\n`s cl @user` — Warning list.\n`s snipe` — Last deleted/edited message.",
        "**Channel / Roles**\n`s lock` — Lock channel.\n`s unlock` — Unlock channel.\n`s role add @user @role` — Add role.\n`s role remove @user @role` — Remove role.\n`s autorole add @role` — Join role.\n`s autorole remove @role` — Remove join role.\n`s si` — Server info.\n`s av [@user]` — Avatar.",
        "**Filters / Automation**\n`s antilink enable|disable` — Server-wide link filter.\n`s bd add <word>` — Add blocked word.\n`s bd remove <word>` — Remove blocked word.\n`s bd list` — List blocked words.\n`s ar #channel <word> <emoji>` — Auto-react.\n`s ar remove #channel` — Remove auto-reaction.",
        "**Embed / AI**\n`s embed` — Shows the embed-builder help; use slash `/embed create` for the full builder.\n`s ai enable|disable` — Enable/disable replies in this channel.\n\nAll commands use the `s` / `S` prefix."
      ];
      return reply(msg,"Kitaryo Bot • Help",pages[0]+"\n\n"+pages[1]+"\n\n"+pages[2]+"\n\n"+pages[3]);
    }
    if (cmd === "purge") {
      if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return reply(msg,"Permission denied","Manage Messages is required.");
      const amount = args[0]?.toLowerCase();
      if (amount === "all") {
        let total=0;
        while (true) {
          const batch = await msg.channel.bulkDelete(100, true).catch(()=>null);
          if (!batch || batch.size===0) break;
          total += batch.size;
          if (batch.size < 100) break;
        }
        return reply(msg,"Purge",`Deleted ${total} messages.`);
      }
      const n = Math.min(Math.max(parseInt(amount,10)||0,1),100);
      const deleted = await msg.channel.bulkDelete(n, true);
      return reply(msg,"Purge",`Deleted ${deleted.size} messages.`);
    }
    if (cmd === "kick" || cmd === "ban") {
      const target = getMember(g,args[0]);
      if (!canTarget(member,target)) return reply(msg,"Action blocked","I can't moderate that member.");
      if (cmd==="kick") { await target.kick("Moderation command"); return reply(msg,"Kick",`${target.user.tag} was kicked.`); }
      await target.ban({reason:"Moderation command"}); return reply(msg,"Ban",`${target.user.tag} was banned.`);
    }
    if (cmd === "av") {
      const u = msg.mentions.users.first() || msg.author;
      return reply(msg,"Avatar",`[Open avatar](${u.displayAvatarURL({size:1024})})`);
    }
    if (cmd === "timeout" || cmd === "mute") {
      const target = getMember(g,args[0]), duration=parseDuration(args[1]);
      if (!duration) return reply(msg,"Invalid time","Use formats like `30m`, `1h`, `1d`.");
      if (!canTarget(member,target)) return reply(msg,"Action blocked","I can't moderate that member.");
      await target.timeout(duration, "Moderation command");
      return reply(msg,"Timeout",`${target.user.tag} timed out for ${args[1]}.`);
    }
    if (cmd === "unmute") {
      const target=getMember(g,args[0]);
      if (!canTarget(member,target)) return reply(msg,"Action blocked","I can't moderate that member.");
      await target.timeout(null,"Moderation command");
      return reply(msg,"Unmute",`${target.user.tag} is no longer timed out.`);
    }
    if (cmd === "warn") {
      const target=getMember(g,args[0]); if (!canTarget(member,target)) return reply(msg,"Action blocked","I can't warn that member.");
      const reason=args.slice(1).join(" ") || "No reason given";
      const arr=db.warnings[g.id] ||= {};
      arr[target.id] ||= [];
      arr[target.id].push({reason,by:msg.author.id,time:Date.now()}); saveDB();
      return reply(msg,"Warning",`${target.user.tag} warned.\nReason: ${reason}`);
    }
    if (cmd === "cw" || cmd === "cl") {
      const target=getMember(g,args[0]); if (!target) return reply(msg,"User not found","Mention or provide a user ID.");
      const arr=(db.warnings[g.id]||{})[target.id]||[];
      if (cmd==="cw") { db.warnings[g.id] ||= {}; db.warnings[g.id][target.id]=[]; saveDB(); return reply(msg,"Warnings cleared",`${target.user.tag}'s warnings were cleared.`); }
      return reply(msg,"Warning list",arr.length?arr.map((x,i)=>`${i+1}. ${x.reason}`).join("\n"):"No warnings.");
    }
    if (cmd === "snipe") {
      const s=db.snipes[g.id]; return reply(msg,"Snipe",s?`Type: ${s.type}\nAuthor: ${s.author}\n${s.content}`:"Nothing to snipe.");
    }
    if (cmd === "lock" || cmd === "unlock") {
      const everyone=g.roles.everyone;
      await msg.channel.permissionOverwrites.edit(everyone,{SendMessages:cmd==="unlock"});
      return reply(msg,cmd==="lock"?"Channel locked":"Channel unlocked",`#${msg.channel.name} updated.`);
    }
    if (cmd === "role") {
      if (!args[0]) return reply(msg,"Role","Use `s role add @user @role` or `s role remove @user @role`.");
      const target=getMember(g,args[1]), role=msg.mentions.roles.first() || g.roles.cache.get(cleanId(args[2]));
      if (!target||!role) return reply(msg,"Role","Provide a user and role.");
      if (role.position >= g.members.me.roles.highest.position) return reply(msg,"Role blocked","That role is above the bot's highest role.");
      if (args[0].toLowerCase()==="add") await target.roles.add(role); else if (args[0].toLowerCase()==="remove") await target.roles.remove(role); else return reply(msg,"Role","Use add/remove.");
      return reply(msg,"Role updated",`${role.name} updated for ${target.user.tag}.`);
    }
    if (cmd === "si") {
      return reply(msg,"Server Information",`**Name:** ${g.name}\n**Members:** ${g.memberCount}\n**Channels:** ${g.channels.cache.size}\n**Roles:** ${g.roles.cache.size}\n**Owner:** <@${g.ownerId}>`);
    }
    if (cmd === "antilink") {
      const action=args[0]?.toLowerCase(); if (!["enable","disable"].includes(action)) return reply(msg,"Anti-link","Use `s antilink enable` or `s antilink disable`.");
      db.antiLink[g.id]=action==="enable"; saveDB(); return reply(msg,"Anti-link",`Anti-link ${action}d for all channels. GIF links are allowed and administrators are exempt.`);
    }
    if (cmd === "bd") {
      const action=args[0]?.toLowerCase(), word=normalizeWord(args.slice(1).join(" "));
      db.blockedWords[g.id] ||= [];
      if (action==="list") return reply(msg,"Blocked words",db.blockedWords[g.id].length?db.blockedWords[g.id].join(", "):"No blocked words.");
      if (!word) return reply(msg,"Blocked words","Use add/remove with a word.");
      if (action==="add"&&!db.blockedWords[g.id].includes(word)) db.blockedWords[g.id].push(word);
      else if (action==="remove") db.blockedWords[g.id]=db.blockedWords[g.id].filter(w=>w!==word);
      else return reply(msg,"Blocked words","Use add/remove/list.");
      saveDB(); return reply(msg,"Blocked words",`${action}: ${word}`);
    }
    if (cmd === "ar") {
      const action=args[0]?.toLowerCase(), ch=msg.mentions.channels.first();
      db.autoReactions[g.id] ||= {};
      if (action==="remove") { if(!ch) return reply(msg,"Auto reaction","Mention a channel."); delete db.autoReactions[g.id][ch.id]; saveDB(); return reply(msg,"Auto reaction","Removed."); }
      const word=args[2], emoji=args[3];
      if (!ch||!word||!emoji) return reply(msg,"Auto reaction","Use `s ar #channel word emoji`.");
      db.autoReactions[g.id][ch.id]={word:normalizeWord(word),emoji}; saveDB(); return reply(msg,"Auto reaction",`Watching **${word}** in ${ch}.`);
    }
    if (cmd === "autorole") {
      const action=args[0]?.toLowerCase(), role=msg.mentions.roles.first() || g.roles.cache.get(cleanId(args[1]));
      if(!role) return reply(msg,"Auto role","Mention a role.");
      db.autoRoles[g.id] ||= [];
      if(action==="add"&&!db.autoRoles[g.id].includes(role.id)) db.autoRoles[g.id].push(role.id);
      else if(action==="remove") db.autoRoles[g.id]=db.autoRoles[g.id].filter(x=>x!==role.id);
      else return reply(msg,"Auto role","Use add/remove.");
      saveDB(); return reply(msg,"Auto role",`${action}: ${role.name}`);
    }
    if (cmd === "embed") return reply(msg,"Embed Builder","Use `s embed` for the embed-builder command.");
    if (cmd === "ai") {
      const action=args[0]?.toLowerCase(); db.aiChannels[g.id] ||= [];
      if(action==="enable"&&!db.aiChannels[g.id].includes(msg.channel.id)) db.aiChannels[g.id].push(msg.channel.id);
      else if(action==="disable") db.aiChannels[g.id]=db.aiChannels[g.id].filter(x=>x!==msg.channel.id);
      else return reply(msg,"AI mode","Use enable or disable.");
      saveDB(); return reply(msg,"AI mode",`AI mode ${action}d in this channel.`);
    }
    return reply(msg,"Unknown command","Use `s help`.");
  } catch(e) {
    console.error(e);
    return reply(msg,"Error","The command could not be completed. Check the bot permissions and role hierarchy.");
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[Unhandled rejection]", err?.rawError || err?.stack || err);
});
process.on("uncaughtException", (err) => {
  console.error("[Uncaught exception]", err?.stack || err);
});

client.login(TOKEN).catch((err) => {
  console.error("[Login failed]", err?.rawError || err?.stack || err);
  process.exit(1);
});

