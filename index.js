require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, Events, MessageFlags
} = require("discord.js");

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN eksik. .env.example dosyasını .env olarak kopyalayıp doldur.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});
const DATA_FILE = path.join(__dirname, "data.json");
let db = { events: {}, warnings: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
} catch (e) { console.error("data.json okunamadı; yeni veri deposu kullanılacak.", e); }
function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function getEvent(guildId) { return db.events[guildId] || null; }
function setEvent(guildId, event) { db.events[guildId] = event; save(); }
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h} sa ${m} dk ${s} sn`;
}
function eventEmbed(ev) {
  const confirmed = ev.attendees.length;
  const reserve = ev.waitlist.length;
  const status = ev.status === "countdown" ? "🟠 Geri sayım" :
    ev.status === "live" ? "🟢 RP DEVAM EDİYOR" :
    ev.status === "ended" ? "⚫ Bitti" : "🔵 Katılım açık";
  return new EmbedBuilder()
    .setColor(ev.status === "live" ? 0x35d07f : 0x8b5cf6)
    .setTitle(`🏡 ${ev.title}`)
    .setDescription(ev.description || "Brookhaven roleplay etkinliği. Katılmak için aşağıdaki butonları kullan.")
    .addFields(
      { name: "📅 Tarih / Saat", value: ev.date, inline: true },
      { name: "📌 Durum", value: status, inline: true },
      { name: "👥 Kadro", value: `${confirmed}/${ev.capacity}`, inline: true },
      { name: "🪑 Yedek", value: `${reserve}`, inline: true },
      { name: "📝 Kayıt", value: ev.registrationOpen ? "Açık" : "Kapalı", inline: true },
      { name: "⏱️ Sayaç", value: ev.startedAt ? fmtDuration((ev.endedAt || Date.now()) - ev.startedAt) : "Henüz başlamadı", inline: true }
    )
    .setFooter({ text: "Brookhaven RP Manager • Kurallara uy, rolünü yap, eğlen!" })
    .setTimestamp();
}
function eventButtons(ev) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rp_join").setLabel("Katılıyorum").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(!ev.registrationOpen || ev.status === "ended"),
    new ButtonBuilder().setCustomId("rp_leave").setLabel("Ayrılıyorum").setEmoji("🚪").setStyle(ButtonStyle.Secondary).setDisabled(ev.status === "ended"),
    new ButtonBuilder().setCustomId("rp_wait").setLabel("Yedek liste").setEmoji("🪑").setStyle(ButtonStyle.Primary).setDisabled(!ev.registrationOpen || ev.status === "ended")
  );
}
async function updatePanel(guild, ev) {
  if (!ev.channelId || !ev.messageId) return;
  try {
    const channel = await guild.channels.fetch(ev.channelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(ev.messageId);
    await message.edit({ embeds: [eventEmbed(ev)], components: [eventButtons(ev)] });
  } catch (e) { console.warn("RP paneli güncellenemedi:", e.message); }
}
async function logMod(guild, text) {
  const id = process.env.MOD_LOG_CHANNEL_ID;
  if (!id) return;
  try {
    const ch = await guild.channels.fetch(id);
    if (ch?.isTextBased()) await ch.send({ content: text });
  } catch (e) { console.warn("Mod log gönderilemedi:", e.message); }
}
const REQUIRED_PERMS = {
  "rp-kur": PermissionFlagsBits.ManageEvents,
  "rp-baslat": PermissionFlagsBits.ManageEvents,
  "rp-bitir": PermissionFlagsBits.ManageEvents,
  "rp-kayit-kapat": PermissionFlagsBits.ManageEvents,
  "rp-kayit-ac": PermissionFlagsBits.ManageEvents,
  "uyar": PermissionFlagsBits.ModerateMembers,
  "timeout": PermissionFlagsBits.ModerateMembers,
  "kick": PermissionFlagsBits.KickMembers,
  "ban": PermissionFlagsBits.BanMembers,
  "oda-kapat": PermissionFlagsBits.ManageChannels,
  "oda-ac": PermissionFlagsBits.ManageChannels
};
const COUNTDOWN_MS = 5 * 60 * 1000;
function scheduleStart(guildId, delay, token) {
  setTimeout(async () => {
    const current = getEvent(guildId);
    if (!current || current.status !== "countdown" || current.countdownAt !== token) return;
    current.status = "live"; current.startedAt = Date.now(); setEvent(guildId, current);
    const g = await client.guilds.fetch(guildId).catch(() => null);
    if (g) {
      await updatePanel(g, current);
      const ch = await g.channels.fetch(current.channelId).catch(() => null);
      if (ch?.isTextBased()) ch.send(`🚨 **${current.title} başladı!** Kadro: ${current.attendees.length}/${current.capacity}. İyi RP!`).catch(() => {});
    }
  }, Math.max(0, delay));
}

client.once(Events.ClientReady, c => {
  console.log(`Giriş yapıldı: ${c.user.tag}`);
  for (const [guildId, ev] of Object.entries(db.events)) {
    if (ev.status === "countdown" && ev.countdownAt) {
      scheduleStart(guildId, ev.countdownAt + COUNTDOWN_MS - Date.now(), ev.countdownAt);
    }
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      const ev = getEvent(interaction.guildId);
      if (!ev || ev.status === "ended") return interaction.reply({ content: "Şu anda aktif bir RP kaydı bulunmuyor.", flags: MessageFlags.Ephemeral });
      const id = interaction.user.id;
      if (!ev.registrationOpen && interaction.customId !== "rp_leave") {
        return interaction.reply({ content: "Kayıtlar şu anda kapalı.", flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === "rp_join") {
        if (ev.attendees.includes(id)) return interaction.reply({ content: "Zaten katılımcı listesindesin.", flags: MessageFlags.Ephemeral });
        if (ev.waitlist.includes(id)) ev.waitlist = ev.waitlist.filter(x => x !== id);
        if (ev.attendees.length >= ev.capacity) {
          ev.waitlist.push(id); save();
          await updatePanel(interaction.guild, ev);
          return interaction.reply({ content: "Kadro dolu! Yedek listesine eklendin.", flags: MessageFlags.Ephemeral });
        }
        ev.attendees.push(id); save();
        await updatePanel(interaction.guild, ev);
        return interaction.reply({ content: "Katılımın kaydedildi. RP duyurularını takip et!", flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === "rp_wait") {
        if (ev.attendees.includes(id) || ev.waitlist.includes(id)) return interaction.reply({ content: "Zaten kadroda veya yedek listesindesin.", flags: MessageFlags.Ephemeral });
        ev.waitlist.push(id); save();
        await updatePanel(interaction.guild, ev);
        return interaction.reply({ content: "Yedek listesine eklendin.", flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === "rp_leave") {
        ev.attendees = ev.attendees.filter(x => x !== id);
        ev.waitlist = ev.waitlist.filter(x => x !== id);
        if (ev.registrationOpen && ev.waitlist.length && ev.attendees.length < ev.capacity) {
          ev.attendees.push(ev.waitlist.shift());
        }
        save(); await updatePanel(interaction.guild, ev);
        return interaction.reply({ content: "Katılım durumun güncellendi.", flags: MessageFlags.Ephemeral });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, channel } = interaction;
    if (!guild) return interaction.reply({ content: "Bu komut yalnızca sunucuda kullanılabilir.", flags: MessageFlags.Ephemeral });
    const need = REQUIRED_PERMS[commandName];
    if (need && !interaction.memberPermissions?.has(need)) {
      return interaction.reply({ content: "Bu komut için yetkin yok.", flags: MessageFlags.Ephemeral });
    }

    if (commandName === "rp-kur") {
      const ev = {
        title: interaction.options.getString("baslik"),
        date: interaction.options.getString("tarih"),
        capacity: interaction.options.getInteger("kapasite"),
        description: interaction.options.getString("aciklama") || "",
        attendees: [], waitlist: [], registrationOpen: true, status: "open",
        createdBy: interaction.user.id, createdAt: Date.now(),
        channelId: channel.id, messageId: null, startedAt: null, endedAt: null
      };
      const msg = await channel.send({ embeds: [eventEmbed(ev)], components: [eventButtons(ev)] });
      ev.messageId = msg.id; setEvent(guild.id, ev);
      return interaction.reply({ content: `RP katılım paneli oluşturuldu: ${msg.url}`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === "rp-baslat") {
      const ev = getEvent(guild.id);
      if (!ev || ev.status === "ended") return interaction.reply({ content: "Önce /rp-kur ile etkinlik oluştur.", flags: MessageFlags.Ephemeral });
      if (ev.status === "live") return interaction.reply({ content: "RP zaten başladı.", flags: MessageFlags.Ephemeral });
      if (ev.status === "countdown") return interaction.reply({ content: "Geri sayım zaten devam ediyor.", flags: MessageFlags.Ephemeral });
      ev.status = "countdown"; ev.countdownAt = Date.now(); setEvent(guild.id, ev);
      await updatePanel(guild, ev);
      scheduleStart(guild.id, COUNTDOWN_MS, ev.countdownAt);
      return interaction.reply({ content: "⏳ 5 dakikalık geri sayım başladı. 5 dakika sonra RP otomatik olarak canlı duruma geçecek.", flags: MessageFlags.Ephemeral });
    }

    if (commandName === "rp-sayac") {
      const ev = getEvent(guild.id);
      if (!ev) return interaction.reply({ content: "Henüz RP oluşturulmamış. /rp-kur kullan.", flags: MessageFlags.Ephemeral });
      const elapsed = ev.startedAt ? fmtDuration((ev.endedAt || Date.now()) - ev.startedAt) : "Henüz başlamadı";
      return interaction.reply({ embeds: [eventEmbed(ev)], content: `⏱️ Geçen süre: **${elapsed}**`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === "rp-bitir") {
      const ev = getEvent(guild.id);
      if (!ev || ev.status === "ended") return interaction.reply({ content: "Bitirilecek aktif RP yok.", flags: MessageFlags.Ephemeral });
      ev.status = "ended"; ev.registrationOpen = false; ev.endedAt = ev.startedAt ? Date.now() : null; setEvent(guild.id, ev);
      await updatePanel(guild, ev);
      const report = `🏁 **${ev.title} bitti!**\nKatılımcı: ${ev.attendees.length}/${ev.capacity}\nYedek: ${ev.waitlist.length}\nSüre: ${ev.startedAt ? fmtDuration(ev.endedAt - ev.startedAt) : "Başlamadan bitirildi."}`;
      await interaction.reply({ content: report });
      await logMod(guild, `📋 RP raporu • ${report}`);
      return;
    }

    if (commandName === "rp-kayit-kapat" || commandName === "rp-kayit-ac") {
      const ev = getEvent(guild.id);
      if (!ev || ev.status === "ended") return interaction.reply({ content: "Aktif RP bulunamadı.", flags: MessageFlags.Ephemeral });
      ev.registrationOpen = commandName === "rp-kayit-ac"; setEvent(guild.id, ev);
      await updatePanel(guild, ev);
      return interaction.reply({ content: ev.registrationOpen ? "✅ RP kayıtları açıldı." : "🔒 RP kayıtları kapatıldı." });
    }

    if (commandName === "rp-kadro") {
      const ev = getEvent(guild.id);
      if (!ev) return interaction.reply({ content: "Aktif RP yok.", flags: MessageFlags.Ephemeral });
      const names = ids => {
        if (!ids.length) return "—";
        let out = "";
        for (let i = 0; i < ids.length; i++) {
          const line = `• <@${ids[i]}>\n`;
          if (out.length + line.length > 940) { out += `… ve ${ids.length - i} kişi daha`; break; }
          out += line;
        }
        return out.trim();
      };
      const embed = new EmbedBuilder().setTitle(`👥 ${ev.title} — Kadro`).setColor(0x8b5cf6)
        .addFields(
          { name: `Katılımcılar (${ev.attendees.length}/${ev.capacity})`, value: names(ev.attendees) },
          { name: `Yedekler (${ev.waitlist.length})`, value: names(ev.waitlist) }
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (["uyar", "timeout", "kick", "ban"].includes(commandName)) {
      const user = interaction.options.getUser("uye");
      const reason = interaction.options.getString("sebep");
      if (user.id === interaction.user.id) return interaction.reply({ content: "Kendine bu işlemi uygulayamazsın.", flags: MessageFlags.Ephemeral });
      if (user.id === client.user.id) return interaction.reply({ content: "Bot üzerinde bu işlem yapılamaz.", flags: MessageFlags.Ephemeral });
      if (commandName === "uyar") {
        db.warnings[user.id] ||= [];
        db.warnings[user.id].push({ guildId: guild.id, moderator: interaction.user.id, reason, at: Date.now() }); save();
        await logMod(guild, `⚠️ Uyarı: <@${user.id}> • Yetkili: ${interaction.user} • Sebep: ${reason}`);
        return interaction.reply({ content: `⚠️ <@${user.id}> uyarıldı. Sebep: **${reason}**`, allowedMentions: { users: [] } });
      }
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        if (commandName === "ban") {
          await guild.members.ban(user.id, { reason });
          await logMod(guild, `⛔ Ban: ${user.tag} • Yetkili: ${interaction.user.tag} • ${reason}`);
          return interaction.reply({ content: `⛔ ${user.tag} yasaklandı (sunucuda değildi). Sebep: ${reason}` });
        }
        return interaction.reply({ content: "Üye bu sunucuda bulunamadı.", flags: MessageFlags.Ephemeral });
      }
      const isOwner = interaction.user.id === guild.ownerId;
      if (member.id === guild.ownerId || (!isOwner && member.roles.highest.position >= interaction.member.roles.highest.position)) {
        return interaction.reply({ content: "Rol hiyerarşisi nedeniyle bu üyeye işlem yapamazsın.", flags: MessageFlags.Ephemeral });
      }
      const botOk = commandName === "timeout" ? member.moderatable : commandName === "kick" ? member.kickable : member.bannable;
      if (!botOk) {
        return interaction.reply({ content: "Botun rolü bu üyenin rolünün altında veya yetkisi yok. Bot rolünü yukarı taşı.", flags: MessageFlags.Ephemeral });
      }
      if (commandName === "timeout") {
        const mins = interaction.options.getInteger("dakika");
        await member.timeout(mins * 60 * 1000, reason);
        await logMod(guild, `🔇 Timeout: ${user.tag} • ${mins} dk • Yetkili: ${interaction.user.tag} • ${reason}`);
        return interaction.reply({ content: `🔇 ${user} ${mins} dakika susturuldu. Sebep: ${reason}` });
      }
      if (commandName === "kick") {
        await member.kick(reason);
        await logMod(guild, `👢 Kick: ${user.tag} • Yetkili: ${interaction.user.tag} • ${reason}`);
        return interaction.reply({ content: `👢 ${user.tag} sunucudan atıldı. Sebep: ${reason}` });
      }
      if (commandName === "ban") {
        await member.ban({ reason });
        await logMod(guild, `⛔ Ban: ${user.tag} • Yetkili: ${interaction.user.tag} • ${reason}`);
        return interaction.reply({ content: `⛔ ${user.tag} yasaklandı. Sebep: ${reason}` });
      }
    }

    if (commandName === "oda-kapat" || commandName === "oda-ac") {
      const everyone = guild.roles.everyone;
      if (!channel.permissionOverwrites) return interaction.reply({ content: "Bu kanal için izinler değiştirilemiyor.", flags: MessageFlags.Ephemeral });
      if (commandName === "oda-kapat") {
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: false, SendMessages: false }, { reason: `Oda kapatıldı: ${interaction.user.tag}` });
        return interaction.reply({ content: `🔒 ${channel} için @everyone erişimi kapatıldı. Bot/yetkili izinlerini kontrol etmeyi unutma.` , flags: MessageFlags.Ephemeral });
      } else {
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: null, SendMessages: null }, { reason: `Oda açıldı: ${interaction.user.tag}` });
        return interaction.reply({ content: `🔓 ${channel} için @everyone erişimi eski (devralınan) haline döndürüldü.`, flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error(err);
    const msg = "Bir hata oluştu. Bot izinlerini ve rol sıralamasını kontrol et.";
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
