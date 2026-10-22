import { describe, expect, it } from 'vitest';
import { classifyUserLookup, exactUserPolicy } from './live/litellm-member-credential.live.mjs';

const userId='probe-00000000-0000-4000-8000-000000000001';
const present=(row:Record<string,unknown>={user_id:userId,max_budget:3,user_role:'internal_user'})=>({status:200,parsed:true,body:{user_id:userId,user_info:row,keys:[],teams:[]}});

describe('native user policy evidence',()=>{
  it('requires the current exact nested identity, global cap and explicit role',()=>{
    expect(exactUserPolicy(classifyUserLookup(present(),userId),userId,3)).toBe(true);
    for(const row of [
      {user_id:userId,max_budget:2,user_role:'internal_user'},
      {user_id:userId,max_budget:3,user_role:null},
      {user_id:userId,max_budget:3,user_role:'proxy_admin'},
      {user_id:userId,max_budget:null,user_role:'internal_user'},
      {user_id:userId,max_budget:'3',user_role:'internal_user'},
      {user_id:'other-user',max_budget:3,user_role:'internal_user'},
    ])expect(exactUserPolicy(classifyUserLookup(present(row),userId),userId,3)).toBe(false);
  });

  it('recognizes only the exact structured missing-user error as absence',()=>{
    for(const code of [404,'404'])expect(classifyUserLookup({status:404,parsed:true,body:{error:{message:`User ${userId} not found`,code}}},userId)).toEqual({kind:'absent'});
    for(const body of [{},{error:{}},{error:{message:'Not Found',code:404}},{error:{message:'User other-user not found',code:404}},{error:{message:`User ${userId} not found`,code:500}}]){
      expect(classifyUserLookup({status:404,parsed:true,body},userId)).toEqual({kind:'malformed'});
    }
  });

  it('keeps refused, malformed and unavailable separate from absence',()=>{
    for(const status of [401,403])expect(classifyUserLookup({status,parsed:false,body:undefined},userId)).toEqual({kind:'refused'});
    expect(classifyUserLookup(undefined,userId)).toEqual({kind:'unavailable'});
    for(const status of [400,429,500,503])expect(classifyUserLookup({status,parsed:true,body:{}},userId)).toEqual({kind:'unavailable'});
    for(const body of [{user_id:userId,user_info:null,keys:[],teams:[]},
      {...present().body,user_id:'other-user'}, {...present().body,keys:null}, {...present().body,teams:null},
      {keys:[]}, {user_id:userId,user_info:{spend:0},keys:[],teams:[]}]){
      expect(classifyUserLookup({status:200,parsed:true,body},userId)).toEqual({kind:'malformed'});
    }
    expect(classifyUserLookup({status:200,parsed:false,body:undefined},userId)).toEqual({kind:'malformed'});
  });
});
