const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('assert/strict');
const {DatabaseSync}=require('node:sqlite');
const repo=path.resolve(__dirname,'../..'),api=path.join(repo,'api');
const nodeRequire=Module.createRequire(path.join(api,'package.json'));
const ts=nodeRequire('typescript');
let clock=Date.parse('2026-09-17T20:00:00+05:00');
const realNow=Date.now; Date.now=()=>clock;
const unix=()=>Math.floor(clock/1000);
const d=new DatabaseSync(':memory:');d.exec(fs.readFileSync(path.join(repo,'database/schema.sql'),'utf8'));
function statement(sql,args=[]){return{bind(...values){return statement(sql,values.map(v=>v===undefined?null:v));},async first(){return d.prepare(sql).get(...args)??null;},async all(){return{results:d.prepare(sql).all(...args)};},async run(){const r=d.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},sql,args};}
const database={prepare:statement,async batch(writes){d.exec('BEGIN');try{const result=[];for(const w of writes)result.push(await w.run());d.exec('COMMIT');return result;}catch(e){d.exec('ROLLBACK');throw e;}}};
const env={zeekay_power_db:database,JWT_SECRET:'local-audit-only',TUYA_CLIENT_ID:'mock',TUYA_CLIENT_SECRET:'mock',TUYA_DEVICE_ID:'mock',TUYA_REGION:'eu'};
let snapshot,failSems=false,commands=[],meter,historyFetch;
const tuyaMock={tuyaConfigured:()=>true,fetchTuyaStatus:async()=>({...meter,updated_at:new Date(clock).toISOString()}),setTuyaRelayAndConfirm:async(e,on)=>{commands.push(on?'ON':'OFF');meter={...meter,relay_on:on};return{...meter,updated_at:new Date(clock).toISOString()};},fetchTuyaEnergyDay:async(e,date)=>historyFetch?historyFetch(e,date):Promise.reject(new Error('disabled in local audit')),fetchTuyaEnergyCapabilities:async()=>({})};
const semsMock={fetchSemsSnapshot:async()=>{if(failSems)throw new Error('SEMS outage');return{...snapshot,ts:unix()};}};
const cache=new Map();
function load(filename,{real=false}={}){
 filename=path.resolve(filename);if(!real&&cache.has(filename))return cache.get(filename).exports;
 const m=new Module(filename);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 if(!real)cache.set(filename,m);
 m.require=(name)=>{
   if(name.startsWith('.')){const target=path.resolve(path.dirname(filename),name)+'.ts';
     if(!real&&target.endsWith(path.join('services','tuya.ts')))return tuyaMock;
     if(!real&&target.endsWith(path.join('services','sems.ts')))return semsMock;
     return load(target);
   }return nodeRequire(name);
 };
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);return m.exports;
}
const service=name=>load(path.join(api,'src','services',name+'.ts'));
const store=service('dashboardStore'),unit=service('unitLock'),auto=service('autoshift'),energy=service('energyStore'),pipeline=service('socPipeline'),controller=service('controllerCommands');
const app=load(path.join(api,'src','index.ts')).default;
const jwt=load(path.join(api,'src','utils','jwt.ts'));
const results=[];
function reset(){
 for(const table of ['app_state','app_events','battery_history','daily_energy_log','wapda_daily_energy','wapda_meter_samples','discharge_daily_energy','controller_commands'])d.exec(`DELETE FROM ${table}`);
 failSems=false;commands=[];historyFetch=null;
 meter={online:true,relay_on:true,energy_total_kwh:102,grid_voltage:230,grid_current:4,grid_power:850,frequency_hz:50,fault:null};
 snapshot={v:48,p_chg:-300,bms_soc:50,solar_power:0,load_power:300,grid_power:850,output_voltage:230,energy_today:12,load_voltage:230,load_current:1.3,battery_current:6.25,frequency:50,wapda_today_kwh:2,charge_day_kwh:1,discharge_day_kwh:2};
}
async function state(key,value){await store.setState(env,key,JSON.stringify(value));}
async function read(key){return JSON.parse(await store.getState(env,key,'null'));}
async function runScheduled(){const waits=[];await app.scheduled({},env,{waitUntil:p=>waits.push(p)});await Promise.all(waits);}
async function request(route,body){const token=await jwt.createToken({id:'audit',name:'Audit',email:'audit@example.invalid'},env.JWT_SECRET);return app.fetch(new Request('https://audit.invalid'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,{waitUntil(){}});}
async function finding(name,action){reset();const evidence=await action();results.push({name,evidence});console.log(JSON.stringify({name,evidence}));}
(async()=>{
 await store.ensureTables(env);
 await finding('SEMS outage leaves a reached Units Lock unenforced',async()=>{
   let p=unit.planUnitLock(null,{nowTs:unix()-60,energyTotalKwh:100},{enabled:true,limit_kwh:1});
   await state('unit_lock_state',p.state);await state('unit_lock_cfg',{enabled:true,limit_kwh:1});failSems=true;
   await runScheduled();const persisted=await read('unit_lock_state');assert.equal(persisted.used_kwh,2);assert.equal(meter.relay_on,false);assert.deepEqual(commands,['OFF']);
   return{new_meter:102,baseline:100,limit:1,used_after_tick:persisted.used_kwh,relay_on:meter.relay_on,commands};
 });
 await finding('SEMS outage leaves an expired auto-shift charging cycle running',async()=>{
   await state('autoshift_cfg',{...auto.AUTOSHIFT_DEFAULT,enabled:true});await state('autoshift_state',{...auto.EMPTY_AUTOSHIFT_STATE,phase:'charging',charge_start_ts:unix()-7200,relay_closed_ts:unix()-7200,until_ts:unix()-3600});failSems=true;
   await runScheduled();assert.equal((await read('autoshift_state')).phase,'idle');assert.deepEqual(commands,['OFF']);return{expired_minutes:60,phase:(await read('autoshift_state')).phase,relay_on:meter.relay_on,commands};
 });
 await finding('Auto-shift disable can undo a simultaneous confirmed manual ON',async()=>{
   await state('autoshift_cfg',{...auto.AUTOSHIFT_DEFAULT,enabled:true});await state('autoshift_state',{...auto.EMPTY_AUTOSHIFT_STATE,phase:'charging',charge_start_ts:unix()-60,relay_closed_ts:unix()-60,until_ts:unix()+3600});
   const original=store.getState;let injected=false;
   store.getState=async(e,key,fallback)=>{const raw=await original(e,key,fallback);if(key==='autoshift_state'&&!injected){injected=true;await controller.enqueueControllerCommand(env,'relay',{state:1});await controller.processControllerCommands(env);}return raw;};
   try{const response=await request('/api/autoshift',{enabled:false});assert.equal(response.status,200);await controller.processControllerCommands(env);assert.deepEqual(commands,['OFF','ON']);assert.equal(meter.relay_on,true);return{http_status:response.status,commands,final_relay_on:meter.relay_on};}finally{store.getState=original;}
 });
 await finding('Auto-shift timer grants a full new duration after a grid loss',async()=>{
   const config={...auto.AUTOSHIFT_DEFAULT,enabled:true,duration_min:60};
   const current={...auto.EMPTY_AUTOSHIFT_STATE,phase:'charging',relay_closed_ts:unix()-50*60,charge_start_ts:unix()-50*60,until_ts:unix()+10*60};
   const input={nowTs:unix(),batteryVoltage:46,pvPower:0,inNightWindow:true,gridConnected:false,relayOn:true};
   const lost=auto.planAutoshift(config,current,input);const returned=auto.planAutoshift(config,lost.state,{...input,nowTs:unix()+300,gridConnected:true});
   assert.equal(returned.state.until_ts-(unix()+300),600);return{charging_before_loss_minutes:50,new_duration_minutes:(returned.state.until_ts-(unix()+300))/60,total_possible_charging_minutes:60};
 });
 await finding('An offline Tuya meter does not pause the auto-shift deadline',async()=>{
   await state('autoshift_cfg',{...auto.AUTOSHIFT_DEFAULT,enabled:true});const before={...auto.EMPTY_AUTOSHIFT_STATE,phase:'charging',relay_closed_ts:unix()-600,charge_start_ts:unix()-600,until_ts:unix()+300};await state('autoshift_state',before);meter.online=false;meter.grid_voltage=null;meter.grid_power=null;
   await pipeline.runSocTick(env);const after=await read('autoshift_state');assert.equal(after.until_ts,null);assert.equal(after.remaining_charge_s,300);assert.equal(after.phase,'waiting_for_grid');return{meter_online:false,phase:after.phase,timer_paused:true};
 });
 await finding('Late morning poll bills daytime units into the finished night lock',async()=>{
   const first=Date.parse('2026-09-17T05:59:00+05:00')/1000,later=Date.parse('2026-09-17T07:30:00+05:00')/1000;
   const start=unit.planUnitLock(null,{nowTs:first,energyTotalKwh:100},{enabled:true,limit_kwh:1});const finish=unit.planUnitLock(start.state,{nowTs:later,energyTotalKwh:102},{enabled:true,limit_kwh:1});
   assert.equal(finish.state.used_kwh,0);assert.equal(finish.enforce_off,false);assert.equal(finish.state.tracking_partial,true);return{last_poll:'05:59',next_poll:'07:30',energy_assigned_to_night:finish.state.used_kwh,locked:finish.enforce_off};
 });
 await finding('A missing daily counter overwrites previously saved solar/charge totals with zero',async()=>{
   d.prepare('INSERT INTO daily_energy_log (date,solar_kwh,charge_kwh) VALUES (?,12,3)').run('2026-09-17');snapshot.energy_today=null;snapshot.charge_day_kwh=null;snapshot.discharge_day_kwh=null;
   await pipeline.runSocTick(env);const row=d.prepare('SELECT solar_kwh,charge_kwh FROM daily_energy_log').get();assert.equal(row.solar_kwh,12);assert.equal(row.charge_kwh,3);return{before:{solar_kwh:12,charge_kwh:3},after:row};
 });
 await finding('Mixed solar/WAPDA charging is assigned entirely to solar',async()=>{
   snapshot.p_chg=300;snapshot.solar_power=500;snapshot.load_power=400;snapshot.grid_power=200;meter.grid_power=200;
   await state('daily_energy',{date:'2026-09-17',pv_peak_w:0,charge_solar_wh:0,charge_wapda_wh:0,last_ts:unix()-60});
   const result=await pipeline.runSocTick(env);assert.equal(result.charge_from_wapda_kwh,.67);assert.equal(result.charge_from_solar_kwh,.33);return{solar_w:500,load_w:400,battery_charge_w:300,grid_w:200,reported_solar_charge_kwh:result.charge_from_solar_kwh,reported_wapda_charge_kwh:result.charge_from_wapda_kwh};
 });
 await finding('A meter increment during history fetch disappears from the effective energy total',async()=>{
   const today='2026-09-17';for(let date='2026-08-22';date<today;date=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10))d.prepare('INSERT INTO wapda_daily_energy (date,reported_kwh,reported_at) VALUES (?,0,?)').run(date,unix());
   d.prepare('INSERT INTO wapda_daily_energy (date,observed_kwh,partial) VALUES (?,5,0)').run(today);
   historyFetch=async()=>{d.prepare('UPDATE wapda_daily_energy SET observed_kwh=6 WHERE date=?').run(today);return 5;};
   await energy.syncTuyaEnergyHistory(env);const day=(await energy.wapdaEnergyDays(env)).find(r=>r.date===today);assert.equal(day.observed_kwh,6);assert.equal(day.kwh,6);return{measured_kwh:day.observed_kwh,billed_kwh:day.kwh,lost_kwh:0};
 });
 await finding('History recovery stops revisiting unfinished previous billing cycles after the 22nd',async()=>{
   const previousClock=clock;clock=Date.parse('2026-09-22T00:05:00+05:00');const called=[];historyFetch=async(e,date)=>{called.push(date);return 0;};
   try{await energy.syncTuyaEnergyHistory(env);assert.equal(called.length,6);assert.ok(called.every(date=>date<'2026-09-22'));assert.ok(called.some(date=>date<'2026-09-22'));return{missing_previous_cycle_start:'2026-08-22',queried_dates:called};}finally{clock=previousClock;}
 });
 await finding('Stale inverter data is re-stamped as a fresh battery sample',async()=>{
   await state('sems_token',{token:'local-only',exp:clock+3600000});const payload={code:0,data:{inverter:[{invert_full:{vbattery1:48,total_pbattery:300,soc:50,last_time:'2026-09-16 20:00:00'},status:-1}],powerflow:{pv:0,load:300,grid:0}}};
   const originalFetch=global.fetch;global.fetch=async()=>new Response(JSON.stringify(payload));const real=load(path.join(api,'src/services/sems.ts'),{real:true});
   try{await assert.rejects(()=>real.fetchSemsSnapshot({...env,SEMS_STATION_ID:'local-only'}),/unavailable or delayed/);return{stale_hardware_rejected:true};}finally{global.fetch=originalFetch;}
 });
 await finding('Status exposes cached relay ON as current even when the meter is offline',async()=>{
   await state('tuya_status',{online:false,relay_on:true,grid_voltage:230,grid_power:850,updated_at:new Date(clock).toISOString()});await state('live_status',{battery_soc:50,bms_soc:50,updated_at:new Date(clock).toISOString()});
   const r=await request('/api/status');const body=await r.json();assert.equal(body.status.breaker_online,false);assert.equal(body.status.relay_closed,null);assert.equal(body.status.relay_state,null);assert.equal(body.status.relay_known,false);return{meter_online:body.status.breaker_online,relay_reported_closed:body.status.relay_closed,grid_voltage:body.status.wapda_voltage};
 });
 await finding('Zero WAPDA watts and a discharging battery still show ACTIVE and auto-shift charging',async()=>{
   meter.grid_power=0;snapshot.grid_power=0;snapshot.p_chg=-300;
   await state('autoshift_cfg',{...auto.AUTOSHIFT_DEFAULT,enabled:true,threshold_v:48.8});await state('autoshift_state',{...auto.EMPTY_AUTOSHIFT_STATE,phase:'waiting_for_grid',relay_closed_ts:unix()-60,trigger_ts:unix()-60,trigger_voltage:48});
   const result=await pipeline.runSocTick(env);assert.equal(result.wapda_active,false);assert.equal(result.autoshift_charging,false);assert.equal(result.battery_charging,false);return{wapda_watts:result.wapda_power,battery_watts:result.battery_power,wapda_active:result.wapda_active,auto_shift_charging:result.autoshift_charging,battery_charging:result.battery_charging};
 });
 await finding('Incomplete discharge coverage can be shown without a partial label',async()=>{
   const pure=service('energy'),window=pure.dischargeWindow(unix())
   d.prepare('INSERT INTO discharge_daily_energy (window_start,date,kwh,covered_s) VALUES (?,?,2,?)').run(window.start-86400,pure.localEnergyDate(window.start-86400),Math.floor(86400*.951));
   const day=(await energy.dischargeDays(env,unix(),7))[1];assert.equal(day.partial,true);return{unmeasured_minutes:Math.round((86400-Math.floor(86400*.951))/60),coverage_pct:day.coverage_pct,labelled_partial:day.partial};
 });
 await finding('Repeated fresh hardware readings keep the device timestamp',async()=>{
   await state('sems_token',{token:'local-only',exp:clock+3600000});
   const deviceTime=new Date(clock).toISOString();
   const payload={code:0,data:{inverter:[{last_time:deviceTime,status:1,invert_full:{vbattery1:48,total_pbattery:300}}],powerflow:{pv:0,load:300,grid:0}}};
   const originalFetch=global.fetch; global.fetch=async()=>new Response(JSON.stringify(payload));
   const real=load(path.join(api,'src/services/sems.ts'),{real:true});
   try {const first=await real.fetchSemsSnapshot({...env,SEMS_STATION_ID:'local-only'});clock+=60000;
     const second=await real.fetchSemsSnapshot({...env,SEMS_STATION_ID:'local-only'});assert.equal(first.ts,second.ts);
     return {duplicate_hardware_timestamp_preserved:true};
   } finally {global.fetch=originalFetch;clock-=60000;}
 });
 await finding('A closing daily energy report cannot double count live observations',async()=>{
   const date='2026-09-16';d.prepare('INSERT INTO wapda_daily_energy (date,observed_kwh,reported_kwh,reported_observed_kwh,reported_at) VALUES (?,2,7,1,?)').run(date,unix());
   const day=(await energy.wapdaEnergyDays(env)).find(r=>r.date===date);assert.equal(day.kwh,7);
   d.prepare('UPDATE wapda_daily_energy SET observed_kwh=8 WHERE date=?').run(date);
   assert.equal((await energy.wapdaEnergyDays(env)).find(r=>r.date===date).kwh,8);
   return {full_day_report_not_added_to_same_day_meter_delta:true,observed_energy_never_discarded:true};
 });
 const vm=require('vm'),html=fs.readFileSync(path.join(api,'public','index.html'),'utf8');
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).find(s=>s.includes('function drawChart'));
 const ast=ts.createSourceFile('dashboard.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),functions={};
 function walk(n){if(ts.isFunctionDeclaration(n)&&n.name)functions[n.name.text]=n.getText(ast);ts.forEachChild(n,walk);}walk(ast);
 await finding('Settings refresh silently replaces an edited auto-shift value',async()=>{
   const nodes={};function element(id){return nodes[id]??={value:'',classList:{toggle(){},contains(){return false;}},setAttribute(){}};}
   element('asThreshold').value='46.5';const context={asDirty:true,$:element,document:{activeElement:element('asDuration')},api:async()=>({success:true,enabled:true,threshold_v:45.8,duration_min:60,pv_stop_w:200,min_on_min:15,cooldown_min:30,units_locked:false,active:false}),fmt:String,fmtTime:String};
   await vm.runInNewContext(functions.loadAutoshift+';loadAutoshift();',context);assert.equal(element('asThreshold').value,'46.5');return{edited_threshold:46.5,after_background_refresh:element('asThreshold').value};
 });
 await finding('SOC chart spaces points by sample count instead of actual time',async()=>{
   const plotted=[];const ctx=new Proxy({createLinearGradient:()=>({addColorStop(){}}),lineTo:(x,y)=>plotted.push([x,y]),moveTo:(x,y)=>plotted.push([x,y])},{get:(o,k)=>k in o?o[k]:(()=>{})});
   const canvas={clientWidth:400,style:{},getContext:()=>ctx};
   const context={$:()=>canvas,window:{devicePixelRatio:1},document:{body:{}},getComputedStyle:()=>({fontFamily:'sans-serif'}),points:[{t:'2026-09-17T00:00:00Z',soc:20},{t:'2026-09-17T00:01:00Z',soc:30},{t:'2026-09-17T01:00:00Z',soc:40}]};
   vm.runInNewContext(functions.drawChart+';drawChart(points);',context);const actual=plotted.find(([x,y])=>Math.abs(y-(14+184*.7))<.001)[0];assert.ok(Math.abs(actual-(34+356/60))<.001);return{elapsed_fraction:1/60,plotted_fraction:1/60,actual_x:actual,correct_x:34+356/60};
 });
 await finding('SOC chart can retain a zero width after being drawn while hidden',async()=>{
   const ctx=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>k in o?o[k]:(()=>{})});const canvas={clientWidth:0,style:{},getContext:()=>ctx};
   vm.runInNewContext(functions.drawChart+';drawChart(points);',{$:()=>canvas,window:{devicePixelRatio:1},document:{body:{}},getComputedStyle:()=>({fontFamily:'sans-serif'}),points:[{soc:50,t:'2026-09-17T00:00:00Z'}]});canvas.clientWidth=400;assert.equal(canvas.width,undefined);canvas.clientWidth=400;vm.runInNewContext(functions.drawChart+';drawChart(points);',{$:()=>canvas,window:{devicePixelRatio:1},document:{body:{}},getComputedStyle:()=>({fontFamily:'sans-serif'}),points:[{soc:50,t:'2026-09-17T00:00:00Z'}]});assert.equal(canvas.width,400);
   assert.ok(html.includes('if(currentView===\"overview\") requestAnimationFrame'));return{width_after_hidden_draw:canvas.width,visible_width:canvas.clientWidth,overview_navigation_redraw:true};
 });
 await finding('Inverter grid-energy tile actually reads the WAPDA meter field',async()=>{
   await state('live_status',{inverter_grid_today_kwh:2,updated_at:new Date(clock).toISOString()});d.prepare('INSERT INTO wapda_daily_energy (date,observed_kwh,partial) VALUES (?,8,1)').run('2026-09-17');
   const response=await request('/api/status');const body=await response.json();assert.equal(body.status.wapda_today_kwh,8);assert.equal(body.status.inverter_grid_today_kwh,2);assert.ok(html.includes('$("tWapdaToday").textContent = fmt(s.inverter_grid_today_kwh,2)'));
   return{inverter_grid_kwh:2,meter_daily_kwh:8,tile_display_value:2,api_exposes_inverter_counter:true};
 });

 console.log('FIX REGRESSIONS PASSED:',results.length);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{Date.now=realNow;d.close();});
