/** Manual probe; never run by CI. Proves what the door's token check branches on. For a valid
 * bot token (xoxb-...), auth.test answers HTTP 200 with { ok:true, team:<string>, user:<string> };
 * for an invalid one it still answers HTTP 200, with { ok:false, error:"invalid_auth" }. The
 * token goes in an Authorization header, never in the URL. Needs a real bot token for a
 * disposable Slack app; auth.test changes nothing.
 * SLACK_PROBE_TOKEN_FILE=/path/to/bot-token pnpm -C services/keeper exec tsx tests/live/slack-auth-test.live.mts
 * Source: https://docs.slack.dev/reference/methods/auth.test/
 */
import {readFileSync} from 'node:fs';
const file=process.env.SLACK_PROBE_TOKEN_FILE;
if(!file) {
  console.log('LIVE VALIDATION PENDING: set SLACK_PROBE_TOKEN_FILE to a disposable bot token file. No network calls made.');
} else {
  const token=readFileSync(file,'utf8').trim();
  if(!/^xoxb-[A-Za-z0-9-]+$/.test(token))throw new Error('Invalid token file.');
  async function authTest(bearer:string):Promise<{status:number;body:{ok?:boolean;team?:unknown;user?:unknown;error?:unknown}}> {
    try {
      const response=await fetch('https://slack.com/api/auth.test',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/x-www-form-urlencoded'},body:'',signal:AbortSignal.timeout(15000),redirect:'error'});
      return {status:response.status,body:await response.json() as never};
    } catch {throw new Error('Slack auth.test failed; provider details omitted to protect the token.');}
  }
  const bad=await authTest('xoxb-invalid');
  if(bad.body.ok!==false)throw new Error('Expected ok:false for an invalid token.');
  console.log(`PASS: an invalid token answers HTTP ${bad.status} with ok:false (error: ${String(bad.body.error)}).`);
  const good=await authTest(token);
  if(good.body.ok!==true||typeof good.body.team!=='string'||typeof good.body.user!=='string')throw new Error('auth.test did not return ok:true with string team and user.');
  console.log(`PASS: a valid token answers ok:true with team "${good.body.team}" and user "${good.body.user}".`);
}
