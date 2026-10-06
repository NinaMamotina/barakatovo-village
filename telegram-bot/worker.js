// Деревня Баракатово: приветствие бота в Telegram.
// Когда человек нажимает «Старт» (или пишет боту что угодно), бот присылает анимацию
// с коротким текстом и кнопками «Играть». Работает как бесплатный Cloudflare Worker.
//
// Нужны две секретные настройки сервиса (Settings → Variables and Secrets):
//   BOT_TOKEN       — токен бота от @BotFather
//   WEBHOOK_SECRET  — любая длинная случайная строка (защита от чужих запросов)

const SITE = 'https://ninamamotina.github.io/barakatovo-village';

const WELCOME_TEXT =
  '<b>Деревня Баракятово</b>\n\n' +
  'Здесь живёт Нор вместе со своей большой и дружной семьёй. ' +
  'Помоги ей встретить утро, сделать омовение, найти верное направление и совершить намаз.\n\n' +
  '<i>Каждый день — новое доброе дело.</i>';

const KEYBOARD = {
  inline_keyboard: [
    [{ text: 'Играть', web_app: { url: SITE + '/Web/index.html' } }],
    [{ text: 'اللعب (العربية)', web_app: { url: SITE + '/Web-ar/index.html' } }],
  ],
};

async function telegram(env, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendWelcome(env, chatId) {
  // сначала пробуем анимацию; если Telegram её не принял, шлём картинку, потом просто текст
  const attempts = [
    ['sendAnimation', { animation: SITE + '/Web/assets/telegram/welcome.mp4' }],
    ['sendPhoto', { photo: SITE + '/Web/assets/telegram/welcome.jpg' }],
  ];
  for (const [method, media] of attempts) {
    const r = await telegram(env, method, {
      chat_id: chatId,
      ...media,
      caption: WELCOME_TEXT,
      parse_mode: 'HTML',
      reply_markup: KEYBOARD,
    });
    if (r.ok) return;
  }
  await telegram(env, 'sendMessage', {
    chat_id: chatId,
    text: WELCOME_TEXT,
    parse_mode: 'HTML',
    reply_markup: KEYBOARD,
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Деревня Баракатово: бот работает');
    if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json();
    const msg = update.message;
    if (msg && msg.chat && msg.chat.type === 'private') {
      await sendWelcome(env, msg.chat.id);
    }
    return new Response('ok');
  },
};
