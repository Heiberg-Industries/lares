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
    {step:4,text:'Paste the token here, save, and apply connection changes. Register the webhook, then send the one-time claim code in a private chat with your bot.'},
  ];
}
