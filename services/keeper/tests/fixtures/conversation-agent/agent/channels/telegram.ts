import {defineChannel,POST} from 'eve/channels';
export default defineChannel({kindHint:'telegram',routes:[POST('/proof/chat',async(request,{from,resolveSession})=>{
 const current=await resolveSession('probe-chat');const startIndex=current?await current.getStreamTailIndex():0;
 const session=await from('probe-chat').send((await request.json()).message,{auth:null});
 return Response.json({sessionId:session.id,startIndex});
})]});
