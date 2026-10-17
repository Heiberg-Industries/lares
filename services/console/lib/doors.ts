/** Pure setup instructions. Public door origin is separate from the private console origin. */
export function publicDoorOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Configure an HTTPS public door origin without credentials, path, query or fragment.');
  return url.origin;
}
export function slackManifest(agent: {name:string;display:string}, consoleUrl:string) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(agent.name)) throw new Error('Invalid agent name');
  const origin=publicDoorOrigin(consoleUrl);
  const manifest={
    display_information:{name:agent.display},
    features:{bot_user:{display_name:agent.display,always_online:false},app_home:{home_tab_enabled:false,messages_tab_enabled:true,messages_tab_read_only_enabled:false}},
    oauth_config:{scopes:{bot:['chat:write','im:history']}},
    settings:{event_subscriptions:{request_url:`${origin}/api/doors/${agent.name}/slack/events`,bot_events:['message.im']},
      interactivity:{is_enabled:true,request_url:`${origin}/api/doors/${agent.name}/slack/events`},org_deploy_enabled:false,socket_mode_enabled:false,token_rotation_enabled:false},
  };
  return {manifest,createUrl:`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`};
}
export function telegramSteps(agent:string):{step:number;text:string}[] {
  return [
    {step:1,text:'Open the verified @BotFather account in Telegram.'},
    {step:2,text:`Send /newbot and enter ${agent} as the display name.`},
    {step:3,text:'Choose an available username ending in bot. Copy the bot token privately.'},
    {step:4,text:'Paste the token below and press Connect. Everything else happens by itself; at the end you tap one link and press Start.'},
  ];
}
/** The door's row as the keeper reports it. `configured` means a token was saved at some point. */
export interface DoorRow {kind:string;enabled:boolean;configured?:boolean;claimed:boolean;mailbox?:string;pending:boolean;pending_reason?:string;applied:boolean}
/** A door the owner has never touched: not enabled, no saved token, no owner, no mailbox. The
 * keeper's pending flag belongs to the whole agent, so it says nothing about such a door. */
export function doorTouched(row?:DoorRow):boolean {
  return Boolean(row&&(row.enabled||row.configured||row.claimed||row.mailbox));
}
export function doorStateText(row?:DoorRow):string {
  if(!row||!doorTouched(row))return 'Not set up';
  if(row.pending)return `Pending: ${row.pending_reason??'Apply connection changes'}`;
  if(row.applied&&row.enabled)return row.claimed?'Connected':'Owner connection applied';
  return row.enabled?'Credentials applied; owner connection still needed':'Credentials saved; door is off';
}
/** Telegram's deep link: opening it and pressing Start sends `/start <code>` to the bot. The
 * code is the one-time code (letters and digits only, which Telegram allows in a start link). */
export function telegramConnectLink(username:string,code:string):string {
  if(!/^[A-Za-z0-9_]{4,32}$/.test(username)||!/^[A-Z0-9]{24}$/.test(code))throw new Error('Invalid Telegram bot username or code');
  return `https://t.me/${username}?start=${code}`;
}
export const slackClaimMessage=(code:string)=>`claim ${code}`;
