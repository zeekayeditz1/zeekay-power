import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ensureTables, getState, setState, acquireTickLock, releaseTickLock } from "../../src/services/dashboardStore";
import { enqueueControllerCommand, processControllerCommands, getControllerCommand } from "../../src/services/controllerCommands";
import { createToken } from "../../src/utils/jwt";

const testEnv:any=env;
const now=()=>Math.floor(Date.now()/1000);
beforeAll(async()=>ensureTables(testEnv));
beforeEach(async()=>{
  await testEnv.zeekay_power_db.prepare("DELETE FROM controller_commands").run();
  await testEnv.zeekay_power_db.prepare("DELETE FROM app_state").run();
});
afterEach(()=>vi.unstubAllGlobals());
async function headers() {
  const token=await createToken({id:"test",name:"Test",email:"test@example.invalid"},"test-only-secret-not-used-in-production");
  return {Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
}

describe("durable manual controller requests",()=>{
  it("saves a disable request while the controller is busy, then completes it",async()=>{
    const lock=await acquireTickLock(testEnv,now());
    const response=await exports.default.fetch(new Request("https://zeekay-power.test/api/unit-lock",{
      method:"POST",headers:await headers(),body:JSON.stringify({enabled:false}),
    }));
    expect(response.status).toBe(202);
    const queued:any=await response.json();
    expect(queued.queued).toBe(true);
    await releaseTickLock(testEnv,lock!);
    await processControllerCommands(testEnv);
    expect(await getControllerCommand(testEnv,queued.command_id)).toMatchObject({status:"completed",queued:false,enabled:false,locked:false});
  });
  it("serializes disable then emergency ON and clears the old auto-shift stop",async()=>{
    await setState(testEnv,"unit_lock_state",JSON.stringify({version:3,locked:true,unlock_ts:now()+3600,used_kwh:6,meter_delta_kwh:6}));
    await setState(testEnv,"autoshift_state",JSON.stringify({phase:"stopping",stop_reason:"unit_limit"}));
    await setState(testEnv,"tuya_token",JSON.stringify({token:"local-test",exp:Date.now()+600000}));
    let relay=false;
    const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.endsWith("/commands")) relay=JSON.parse(init?.body as string).commands[0].value;
      const result=url.endsWith("/status") ? [{code:"switch",value:relay}] : url.endsWith("/commands") ? true : {online:true};
      return new Response(JSON.stringify({success:true,result}),{headers:{"Content-Type":"application/json"}});
    });
    vi.stubGlobal("fetch",fetch);
    const hardwareEnv={...testEnv,TUYA_CLIENT_ID:"test",TUYA_CLIENT_SECRET:"test",TUYA_DEVICE_ID:"test",TUYA_REGION:"eu"};
    const disable=await enqueueControllerCommand(testEnv,"unit-lock",{enabled:false});
    const on=await enqueueControllerCommand(testEnv,"relay",{state:1});
    await processControllerCommands(hardwareEnv);
    await processControllerCommands(hardwareEnv);
    expect(await getControllerCommand(testEnv,disable)).toMatchObject({enabled:false,status:"completed"});
    expect(await getControllerCommand(testEnv,on)).toMatchObject({relay_state:1,confirmed:true,status:"completed"});
    expect(JSON.parse(await getState(testEnv,"autoshift_state","{}"))).toMatchObject({phase:"idle",stop_reason:null});
    expect(relay).toBe(true);
  });
  it("rechecks Units Lock under the lock before allowing manual ON",async()=>{
    await setState(testEnv,"unit_lock_state",JSON.stringify({version:3,locked:true,unlock_ts:now()+3600,used_kwh:6,meter_delta_kwh:6}));
    const id=await enqueueControllerCommand(testEnv,"relay",{state:1});
    await processControllerCommands(testEnv);
    const result=await getControllerCommand(testEnv,id);
    expect(result).toMatchObject({status:"failed",code:"UNIT_LOCK_ACTIVE"});
    expect(result).not.toHaveProperty("confirmed");
  });
  it("expires an old command without switching hardware",async()=>{
    const id=await enqueueControllerCommand(testEnv,"relay",{state:1});
    await testEnv.zeekay_power_db.prepare("UPDATE controller_commands SET created_ts=? WHERE id=?").bind(now()-181,id).run();
    await processControllerCommands(testEnv);
    expect(await getControllerCommand(testEnv,id)).toMatchObject({status:"failed",http_status:408});
  });
  it("hides stale mains voltage instead of borrowing inverter voltage",async()=>{
    await setState(testEnv,"tuya_reachable","0");
    await setState(testEnv,"tuya_status",JSON.stringify({online:true,relay_on:false,grid_voltage:230,grid_power:0,updated_at:new Date().toISOString()}));
    await setState(testEnv,"live_status",JSON.stringify({battery_soc:40,bms_soc:61,inverter_voltage:231,grid_voltage:230,mains_available:true,updated_at:new Date().toISOString()}));
    const response=await exports.default.fetch(new Request("https://zeekay-power.test/api/status",{headers:await headers()}));
    const result:any=await response.json();
    expect(result.status).toMatchObject({wapda_available:false,wapda_active:false,wapda_voltage:null,grid_voltage:null,mains_available:false,inverter_voltage:231,bms_soc:61});
  });
});
