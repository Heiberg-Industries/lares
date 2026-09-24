import {pool} from '../../../../../../lib/db';
import {forwardDoor} from '../../../../../../lib/door-forwarder';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{name:string;kind:string}>}) {
 const {name,kind}=await context.params;
 return forwardDoor(request,name,kind,{query:(sql,values)=>{const config={text:sql,values,query_timeout:3000};return pool.query(config);},fetch});
}
