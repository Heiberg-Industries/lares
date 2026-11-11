import {defineChannel,POST} from 'eve/channels';
// A raw chat address: every message to 'probe-chat' reaches whichever session currently uses it.
export default defineChannel({routes:[POST('/proof/chat',async(request,{from,resolveSession})=>{
 const current=await resolveSession('probe-chat');const startIndex=current?await current.getStreamTailIndex():0;
 const delivery=await from('probe-chat').send((await request.json()).message,{auth:null});
 return Response.json({sessionId:delivery.sessionId,startIndex});
})]});
