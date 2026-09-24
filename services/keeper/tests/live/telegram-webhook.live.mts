/** Manual dedicated-bot probe; never run by CI. Requires TELEGRAM_PROBE_TOKEN_FILE and
 * TELEGRAM_PROBE_URL=https://<public-origin>/api/doors/<dedicated-agent>/telegram/events.
 * It first reads getWebhookInfo. An existing webhook is REFUSED: Telegram does not return
 * its secret_token, certificate or all registration inputs, so blind replacement cannot
 * restore it. Use a disposable bot with no webhook. Never use a production bot.
 * Source: https://core.telegram.org/bots/api#setwebhook
 */
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const file=process.env.TELEGRAM_PROBE_TOKEN_FILE;
const value=process.env.TELEGRAM_PROBE_URL;
if(!file||!value) {
  console.log('LIVE VALIDATION PENDING: provide a dedicated disposable bot token file and public HTTPS door URL in Task20. No network calls made.');
} else {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/api\/doors\/[a-z][a-z0-9-]{1,30}\/telegram\/events$/.test(url.pathname))throw new Error('Invalid probe door URL.');
  const token=readFileSync(file,'utf8').trim();
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('Invalid token file.');
  async function api(method:'getWebhookInfo'|'setWebhook'|'deleteWebhook',body:object={}) {
    try {
      const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const data=await response.json() as {ok?:boolean;result?:unknown};
      if(!response.ok||data.ok!==true)throw new Error('API refusal');
      return data.result;
    } catch {throw new Error(`Telegram ${method} failed; provider details omitted to protect token. Outcome may be unknown.`);}
  }
  const before=await api('getWebhookInfo') as {url?:unknown};
  if(typeof before.url!=='string')throw new Error('Unexpected getWebhookInfo response; refusing mutation.');
  if(before.url!=='')throw new Error('Existing webhook detected. Refusing to replace it because full restoration data is unavailable. Use a disposable bot.');
  console.log('PASS: dedicated bot has no existing webhook.');
  let attempted=false;
  try {
    attempted=true;
    await api('setWebhook',{url:value,secret_token:randomBytes(32).toString('hex'),allowed_updates:['message','callback_query'],drop_pending_updates:false});
    console.log('PASS: setWebhook accepted generated secret_token and door URL.');
    const after=await api('getWebhookInfo') as {url?:unknown};
    if(after.url!==value)throw new Error('Registered URL did not match.');
    console.log('PASS: getWebhookInfo reads back the exact URL (secret_token is not returned).');
  } finally {
    if(attempted) {
      await api('deleteWebhook',{drop_pending_updates:false});
      const restored=await api('getWebhookInfo') as {url?:unknown};
      if(restored.url!=='')throw new Error('RESTORATION FAILED: inspect dedicated bot manually.');
      console.log('PASS: deleteWebhook restored the original no-webhook state without dropping pending updates.');
    }
  }
}
