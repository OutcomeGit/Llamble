// Curated emoji set with shortcodes for search + :autocomplete:
const RAW: Record<string, string> = {
  Smileys: "😀 grinning|😃 smiley|😄 smile|😁 grin|😆 laughing|😅 sweat_smile|🤣 rofl|😂 joy|🙂 slight_smile|🙃 upside_down|😉 wink|😊 blush|😇 innocent|🥰 smiling_hearts|😍 heart_eyes|🤩 star_struck|😘 kiss|😋 yum|😛 tongue|😜 wink_tongue|🤪 zany|😝 squint_tongue|🤑 money_mouth|🤗 hug|🤭 hand_mouth|🤫 shush|🤔 thinking|🤐 zipper|🤨 raised_eyebrow|😐 neutral|😑 expressionless|😶 no_mouth|😏 smirk|😒 unamused|🙄 eye_roll|😬 grimace|😮‍💨 exhale|🤥 lying|😌 relieved|😔 pensive|😪 sleepy|🤤 drool|😴 sleeping|😷 mask|🤒 sick|🤕 hurt|🤢 nauseated|🤮 vomit|🤧 sneeze|🥵 hot|🥶 cold|🥴 woozy|😵 dizzy|🤯 exploding_head|🤠 cowboy|🥳 party|😎 sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 frown|😮 open_mouth|😯 hushed|😲 astonished|😳 flushed|🥺 pleading|😦 frowning|😧 anguished|😨 fearful|😰 anxious|😥 sad_relieved|😢 cry|😭 sob|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary|😫 tired|🥱 yawn|😤 triumph|😡 rage|😠 angry|🤬 cursing|😈 smiling_imp|👿 imp|💀 skull|☠️ skull_bones|💩 poop|🤡 clown|👹 ogre|👻 ghost|👽 alien|🤖 robot|😺 cat_smile|😹 cat_joy|😻 cat_heart|🙈 see_no_evil|🙉 hear_no_evil|🙊 speak_no_evil",
  People: "👋 wave|🤚 raised_back|✋ raised_hand|🖖 vulcan|👌 ok_hand|🤌 pinched|🤏 pinch|✌️ v|🤞 crossed_fingers|🤟 love_you|🤘 metal|🤙 call_me|👈 point_left|👉 point_right|👆 point_up|👇 point_down|☝️ index_up|👍 thumbsup|👎 thumbsdown|✊ fist|👊 punch|🤛 left_fist|🤜 right_fist|👏 clap|🙌 raised_hands|👐 open_hands|🤲 palms_up|🤝 handshake|🙏 pray|✍️ writing|💅 nail_polish|💪 muscle|🧠 brain|👀 eyes|👁️ eye|👅 tongue_out|👄 lips|🫡 salute|🫶 heart_hands|🧑‍💻 technologist|🧙 mage|🥷 ninja|🧑‍🚀 astronaut|👶 baby|🧒 child|🧓 older_person",
  Nature: "🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn|🐝 bee|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🦖 trex|🐙 octopus|🦑 squid|🦀 crab|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🦭 seal|🐋 orca|🌵 cactus|🎄 xmas_tree|🌲 evergreen|🌴 palm_tree|🌱 seedling|🍀 four_leaf|🍁 maple_leaf|🌸 cherry_blossom|🌹 rose|🌻 sunflower|🌞 sun_face|🌙 moon|⭐ star|🌟 glowing_star|✨ sparkles|⚡ zap|🔥 fire|🌈 rainbow|☀️ sunny|🌧️ rain|⛈️ storm|❄️ snowflake|🌊 wave_water|💧 droplet",
  Food: "🍏 green_apple|🍎 apple|🍐 pear|🍊 orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥑 avocado|🍆 eggplant|🌶️ hot_pepper|🌽 corn|🥕 carrot|🥔 potato|🥐 croissant|🍞 bread|🧀 cheese|🥚 egg|🍳 cooking|🥓 bacon|🥩 steak|🍗 drumstick|🌭 hotdog|🍔 burger|🍟 fries|🍕 pizza|🌮 taco|🌯 burrito|🥗 salad|🍝 spaghetti|🍜 ramen|🍣 sushi|🍤 shrimp|🍦 ice_cream|🍩 doughnut|🍪 cookie|🎂 birthday|🍰 cake|🧁 cupcake|🍫 chocolate|🍬 candy|🍿 popcorn|☕ coffee|🍵 tea|🧋 boba|🍺 beer|🍻 beers|🍷 wine|🍸 cocktail|🥤 soda|🧃 juice",
  Activity: "⚽ soccer|🏀 basketball|🏈 football|⚾ baseball|🎾 tennis|🏐 volleyball|🎱 8ball|🏓 ping_pong|🏒 hockey|⛳ golf|🎣 fishing|🥊 boxing|🎽 running_shirt|🛹 skateboard|🏆 trophy|🥇 first_place|🥈 second_place|🥉 third_place|🏅 medal|🎮 video_game|🕹️ joystick|🎲 game_die|♟️ chess|🧩 puzzle|🎯 dart|🎳 bowling|🎨 art|🎬 clapper|🎤 microphone|🎧 headphones|🎸 guitar|🎹 piano|🥁 drum|🎷 sax|🎺 trumpet|🎻 violin|🎉 tada|🎊 confetti|🎈 balloon|🎁 gift",
  Travel: "🚗 car|🚕 taxi|🚌 bus|🏎️ race_car|🚓 police_car|🚑 ambulance|🚒 fire_engine|🚚 truck|🚲 bike|🛵 scooter|🏍️ motorcycle|✈️ airplane|🚀 rocket|🛸 ufo|🚁 helicopter|⛵ sailboat|🚤 speedboat|🛳️ ship|⚓ anchor|🚂 train|🗺️ map|🧭 compass|🏔️ mountain|🌋 volcano|🏕️ camping|🏖️ beach|🏝️ island|🏠 house|🏢 office|🏰 castle|🗽 statue_liberty|🌃 night_city|🌅 sunrise|🎡 ferris_wheel|🎢 roller_coaster",
  Objects: "⌚ watch|📱 phone|💻 laptop|⌨️ keyboard|🖥️ desktop|🖨️ printer|🖱️ computer_mouse|💾 floppy|💿 cd|📷 camera|🎥 movie_camera|📺 tv|📻 radio|🔋 battery|🔌 plug|💡 bulb|🔦 flashlight|🕯️ candle|💸 money_wings|💵 dollar|💰 moneybag|💳 credit_card|💎 gem|🔧 wrench|🔨 hammer|🛠️ tools|⚙️ gear|🔩 nut_bolt|🧲 magnet|🔫 water_gun|💣 bomb|🔪 knife|🛡️ shield|🔮 crystal_ball|💊 pill|🧬 dna|🔬 microscope|🔭 telescope|📦 package|📫 mailbox|📝 memo|📁 folder|📅 calendar|📌 pushpin|📎 paperclip|✂️ scissors|🔒 lock|🔓 unlock|🔑 key|🗝️ old_key|🧸 teddy|🪄 magic_wand|🧯 extinguisher|🛒 cart",
  Symbols: "❤️ heart|🧡 orange_heart|💛 yellow_heart|💚 green_heart|💙 blue_heart|💜 purple_heart|🖤 black_heart|🤍 white_heart|🤎 brown_heart|💔 broken_heart|❣️ heart_exclamation|💕 two_hearts|💞 revolving_hearts|💓 heartbeat|💗 heartpulse|💖 sparkling_heart|💘 cupid|💯 100|💢 anger|💥 boom|💫 dizzy_star|💦 sweat_drops|💨 dash|💬 speech|💭 thought|💤 zzz|✅ white_check|☑️ ballot_check|✔️ check|❌ x|❎ x_box|➕ plus|➖ minus|➗ divide|❓ question|❗ exclamation|‼️ bangbang|⁉️ interrobang|⚠️ warning|🚫 no_entry|⛔ no_entry_sign|🔞 underage|♻️ recycle|🔴 red_circle|🟠 orange_circle|🟡 yellow_circle|🟢 green_circle|🔵 blue_circle|🟣 purple_circle|⚫ black_circle|⚪ white_circle|🔺 red_triangle|🔻 down_triangle|🆗 ok|🆕 new|🆒 cool|🆓 free|🔝 top|🔜 soon|▶️ play|⏸️ pause|⏹️ stop|⏺️ record|⏩ fast_forward|🔁 repeat|🔀 shuffle|🎵 musical_note|🎶 notes|➡️ arrow_right|⬅️ arrow_left|⬆️ arrow_up|⬇️ arrow_down|🔄 arrows_counterclockwise|🏁 checkered_flag|🚩 red_flag|🏳️ white_flag|🏴‍☠️ pirate_flag|🏳️‍🌈 rainbow_flag",
};

export interface EmojiEntry {
  e: string;
  n: string;
}

export const EMOJI: { category: string; items: EmojiEntry[] }[] = Object.entries(RAW).map(([category, s]) => ({
  category,
  items: s.split("|").map((p) => {
    const i = p.indexOf(" ");
    return { e: p.slice(0, i), n: p.slice(i + 1) };
  }),
}));

export const ALL_EMOJI: EmojiEntry[] = EMOJI.flatMap((c) => c.items);

export function searchEmoji(q: string, limit = 40): EmojiEntry[] {
  const t = q.toLowerCase().replace(/^:|:$/g, "");
  if (!t) return ALL_EMOJI.slice(0, limit);
  const starts = ALL_EMOJI.filter((x) => x.n.startsWith(t));
  const contains = ALL_EMOJI.filter((x) => !x.n.startsWith(t) && x.n.includes(t));
  return [...starts, ...contains].slice(0, limit);
}

export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem("parley.recentEmoji") || "[]");
  } catch {
    return [];
  }
}

export function pushRecentEmoji(e: string) {
  const r = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24);
  localStorage.setItem("parley.recentEmoji", JSON.stringify(r));
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
