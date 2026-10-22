import {afterEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {main,rootApplyRefusal} from '../bin/erase-person.js';

const pools:Pool[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.end()));});

describe('root-only person erasure command',()=>{
  it('requires Linux root for apply',()=>{
    expect(rootApplyRefusal('linux',0)).toBeUndefined();
    expect(rootApplyRefusal('linux',501)).toMatch(/root on Linux/);
    expect(rootApplyRefusal('darwin',0)).toMatch(/root on Linux/);
  });

  it('refuses apply without prepared custody before any database checkout',async()=>{
    const db=new Pool({host:'127.0.0.1',port:1,database:'unused'});pools.push(db);const output:string[]=[];
    const code=await main(['fixture-person','--apply'],{db,out:value=>output.push(value)});
    expect(code).toBe(1);expect(output.join('\n')).toMatch(/prepared financial custody/i);
  });
});
