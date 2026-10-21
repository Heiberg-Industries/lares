import {relayGatewayBudget} from '../../../../lib/gateway-budget-relay';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request) {return relayGatewayBudget(request);}
