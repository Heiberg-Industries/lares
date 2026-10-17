/** Manual probe; never run by CI. Proves the two Telegram behaviours the "Tap to connect" door
 * depends on, with a disposable bot that has NO webhook (getUpdates does not work beside one):
 *   1. getMe returns { ok:true, result:{ is_bot:true, username } } for a valid token, and ok:false
 *      for a bad one.
 *   2. Opening https://t.me/<username>?start=<CODE> and pressing Start delivers a private-chat
 *      message whose text is exactly "/start <CODE>" (an upper-case 24 character code survives
 *      untouched). The probe prints the link, waits up to two minutes for you to tap it, and
 *      compares the text it receives.
 * TELEGRAM_PROBE_TOKEN_FILE=/path/to/token pnpm -C services/keeper exec tsx tests/live/telegram-start-link.live.mts
 * Source: https://core.telegram.org/bots/api#getme and https://core.telegram.org/api/links#bot-links
 */
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const file=process.env.TELEGRAM_PROBE_TOKEN_FILE;
if(!file) {
  console.log('LIVE VALIDATION PENDING: set TELEGRAM_PROBE_TOKEN_FILE to a disposable bot token file. No network calls made.');
} else {
  const token=readFileSync(file,'utf8').trim();
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('Invalid token file.');
  async function api(method:string,body:object={},bot=token):Promise<{ok?:boolean;result?:any}> {
    try {
      const response=await fetch(`https://api.telegram.org/bot${bot}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
      return await response.json() as {ok?:boolean;result?:any};
    } catch {throw new Error(`Telegram ${method} failed; provider details omitted to protect the token.`);}
  }
  const bad=await api('getMe',{},'1:invalid');
  if(bad.ok!==false)throw new Error('Expected ok:false for an invalid token.');
  console.log('PASS: getMe answers ok:false for an invalid token.');
  const me=await api('getMe');
  if(me.ok!==true||me.result?.is_bot!==true||!/^[A-Za-z0-9_]{4,32}$/.test(me.result?.username??''))throw new Error('getMe did not return a bot with a plain username.');
  const username:string=me.result.username;
  console.log(`PASS: getMe returned bot @${username}.`);
  const info=await api('getWebhookInfo');
  if(info.result?.url)throw new Error('This bot has a webhook; use a disposable bot with none.');
  const code=randomBytes(12).toString('hex').toUpperCase();
  console.log(`Open this link on your phone and press Start (waiting up to 2 minutes):\nhttps://t.me/${username}?start=${code}`);
  const deadline=Date.now()+120000;let offset=0,seen='';
  while(Date.now()<deadline&&!seen) {
    const updates=await api('getUpdates',{offset,timeout:25,allowed_updates:['message']});
    for(const u of updates.result??[]) {
      offset=u.update_id+1;
      if(u.message?.chat?.type==='private'&&typeof u.message.text==='string'&&u.message.text.startsWith('/start'))seen=u.message.text;
    }
  }
  if(seen!==`/start ${code}`)throw new Error(`Expected the message "/start <code>", received ${seen?`"${seen.replace(code,'<code>')}"`:'nothing'}.`);
  console.log('PASS: Start delivered exactly "/start <code>" in a private chat.');
}
