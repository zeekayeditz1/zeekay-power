/*
| Hybrid lead-acid SOC estimator (ported from the verified standalone engine).
| 48V flooded bank (4×12V 140Ah series = 48V,140Ah). Blends coulomb-counting +
| load-compensated voltage + true-rest anchoring; learns Ri, usable Ah, charge eff.
*/
export const RESTING_CURVE: [number, number][] = [
  [50.80,100],[50.00,90],[49.68,80],[49.28,70],[48.80,60],
  [48.24,50],[47.60,40],[47.00,30],[46.32,20],[45.24,10],[42.00,0],
];
export function socFromRestingVoltage(v: number): number {
  const c = RESTING_CURVE;
  if (v >= c[0][0]) return 100;
  if (v <= c[c.length-1][0]) return 0;
  for (let i=0;i<c.length-1;i++){ const [vh,sh]=c[i],[vl,sl]=c[i+1];
    if (v<=vh && v>=vl){ const t=(v-vl)/(vh-vl); return sl+t*(sh-sl); } }
  return 50;
}
export const DEFAULTS = {
  c_usable_ah:140, ri_ohm:0.030, eta_charge:0.87, k_blend:0.03,
  rest_current_a:1.5, rest_min_s:1800,
  ri_bounds:[0.010,0.080] as [number,number],
  cap_bounds:[80,160] as [number,number],
};
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));

/*
| Two consecutive samples are only treated as a continuous stretch of time if
| they are at most this far apart. The cron ticks every 60s, so 180s tolerates
| a couple of missed ticks. Anything longer is a real gap (worker downtime, a
| deploy, a SEMS outage) and contributes ZERO measured time: it must not be
| integrated into the coulomb count, and it must not count toward the 30-minute
| "battery has been at rest" condition that triggers a voltage anchor.
*/
const MAX_CONTIGUOUS_SAMPLE_GAP_S = 180;
export interface SocState {
  soc?:number; c_usable_ah?:number; ri_ohm?:number; eta_charge?:number;
  last_ts?:number|null; rest_run_s?:number; last_anchor_ts?:number;
  ah_since_anchor?:number; soc_at_anchor?:number; _prev?:{v:number;i:number};
  soc_cc?:number; soc_v?:number; anchored?:boolean; blended?:number; bms_soc?:number|null;
}
export interface Sample { v:number; p_chg:number; ts:number; bms_soc?:number|null; }

export function step(state: SocState, sample: Sample, cfg = DEFAULTS): SocState {
  const s: SocState = { c_usable_ah:cfg.c_usable_ah, ri_ohm:cfg.ri_ohm, eta_charge:cfg.eta_charge, ...state };
  const { v, p_chg, ts } = sample;
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(p_chg) || !Number.isFinite(ts)) {
    throw new Error("invalid SOC sample");
  }
  if (s.last_ts == null) {
    const i0 = p_chg / v; const v_rest0 = v - i0*(s.ri_ohm as number);
    s.soc = socFromRestingVoltage(v_rest0);
    s.last_ts = ts; s.rest_run_s = 0; s.last_anchor_ts = ts;
    s.ah_since_anchor = 0; s.soc_at_anchor = s.soc; s._prev = { v, i:i0 };
    // The very first sample seeds SOC from voltage under whatever load happens
    // to be running — that is a starting guess, not a true rest anchor, so it
    // must not be reported as anchored.
    return { ...s, soc_cc:s.soc, soc_v:s.soc, anchored:false, blended:s.soc };
  }
  const rawDt = ts - (s.last_ts as number);
  const contiguous = rawDt >= 0 && rawDt <= MAX_CONTIGUOUS_SAMPLE_GAP_S;
  const dtMeasured = contiguous ? rawDt : 0;
  const dt_h = dtMeasured / 3600;
  const i_signed = p_chg / v;
  let dAh = i_signed*dt_h; if (dAh>0) dAh *= (s.eta_charge as number);
  const soc_cc = clamp((s.soc as number) + (dAh/(s.c_usable_ah as number))*100, 0, 100);
  s.ah_since_anchor = (s.ah_since_anchor||0) + dAh;
  const v_rest = v - i_signed*(s.ri_ohm as number);
  const soc_v = socFromRestingVoltage(v_rest);
  if (s._prev && contiguous && rawDt>0){ const dI=i_signed-s._prev.i, dV=v-s._prev.v;
    if (Math.abs(dI)>3){ const ri=-dV/dI; if (ri>0) s.ri_ohm=clamp(0.9*(s.ri_ohm as number)+0.1*ri,cfg.ri_bounds[0],cfg.ri_bounds[1]); } }
  s._prev = { v, i:i_signed };
  const chargerHolding = i_signed>0.3 && v>50.4;
  const nearRest = Math.abs(i_signed)<cfg.rest_current_a && !chargerHolding;
  s.rest_run_s = (nearRest && contiguous) ? (s.rest_run_s||0)+dtMeasured : 0;
  let anchored=false;
  if ((s.rest_run_s as number)>=cfg.rest_min_s && v_rest<=50.8 && v_rest>=42.0){
    const dSoc = soc_v-(s.soc_at_anchor ?? soc_v);
    if (Math.abs(dSoc)>=8 && Math.abs(s.ah_since_anchor as number)>3){
      const cap=Math.abs(s.ah_since_anchor as number)/(Math.abs(dSoc)/100);
      s.c_usable_ah=clamp(0.8*(s.c_usable_ah as number)+0.2*cap,cfg.cap_bounds[0],cfg.cap_bounds[1]); }
    s.soc=soc_v; s.soc_at_anchor=soc_v; s.ah_since_anchor=0; s.last_anchor_ts=ts; s.rest_run_s=0; anchored=true;
  } else {
    s.soc = clamp(soc_cc + cfg.k_blend*(soc_v-soc_cc),0,100);
  }
  s.last_ts = ts;
  return { ...s, soc_cc, soc_v, anchored, blended:s.soc };
}
