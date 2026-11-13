'use strict';
// Actual canvas/editor + local chemistry; deterministic fixture, no model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-orient-hydrogen-real');
const SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures/orient-hydrogen-regression.molwork'), 'utf8');
const PORT = Number(process.env.MOLSTUDIO_PORT) || 49086;
const BUILD = process.env.MOLSTUDIO_TEST_BUILD || 'current served resources';
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-orient-hydrogen-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', build: BUILD,
  service: `http://127.0.0.1:${PORT}`, modelCalls: 0,
  scope: 'Existing explicit O–H is aimed at existing O−; IDs, chemistry, flow geometry, native history and rejection guards are checked.', checks: [] };
let win;
const write = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.ok = false; report.error = 'watchdog'; write(); win?.destroy(); app.exit(2); }, 120_000);

async function exercise() {
  const MW = MolWorkbench, { adapter, controller, model } = MW.app, M = MW.model, R = MW.route, ed = adapter.ed, api = k3dAPI.agent;
  const H = 'at-69095204-e256-49a7-a758-3f1a5243e7ba';
  const target = 'at-dfa73571-7c36-4138-88c6-e21b04c921b3';
  const pair = 'lp-63526a21-5bf9-4ba3-aa40-d41a6ba8db13';
  const flow = 'ar-12cc12ba-68ea-4f1c-8f75-457a765f7b10';
  const checks = window.orientChecks = [], samples = window.orientSamples = {};
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, ...(pass || detail === undefined ? {} : { detail }) }); if (!pass) throw new Error(name); };
  const context = () => api.getContext(), history = () => ({ pointer: ed.historyPtr, ...ed.historySize() });
  const atomMap = c => new Map(c.atoms.map(a => [a.id, a]));
  const canonical = value => {
    const ordered = x => Array.isArray(x) ? x.map(ordered) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, ordered(x[k])])) : x;
    return JSON.stringify(ordered(value));
  };
  const chemistry = c => canonical({
    atoms: c.atoms.map(({ id, label, charge, radical, aromatic, isotope, implicitH, stereoLabel, stereoParity, alias }) =>
      ({ id, label, charge, radical, aromatic, isotope, implicitH, stereoLabel, stereoParity, alias })).sort((a,b) => a.id.localeCompare(b.id)),
    bonds: c.bonds.map(({ id, begin, end, order, nativeType, aromatic, stereo }) => ({ id, begin, end, order, nativeType, aromatic, stereo })).sort((a,b) => a.id.localeCompare(b.id)),
    flowIds: c.arrows.map(a => a.id).sort(), pairIds: c.lonePairs.map(a => a.id).sort(), stepIds: c.reactionSteps.map(a => a.stepId).sort(),
  });
  const coords = c => canonical(c.atoms.map(a => [a.id, Math.round(a.x*1e6)/1e6, Math.round(a.y*1e6)/1e6]).sort((a,b) => a[0].localeCompare(b[0])));
  const length = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const oriented = c => {
    const atoms = atomMap(c), h = atoms.get(H), parent = atoms.get(h?.neighbors?.[0]?.uuid), dest = atoms.get(target);
    if (!h || !parent || !dest) return null;
    const u = { x:h.x-parent.x, y:h.y-parent.y }, v = { x:dest.x-parent.x, y:dest.y-parent.y };
    return { parentId:parent.id, length:length(h,parent), cosine:(u.x*v.x+u.y*v.y)/(Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y)) };
  };
  const translatedMolecules = (before, after) => {
    const a = atomMap(before), b = atomMap(after);
    return before.molecules.every(mol => {
      const anchor = mol.atoms.find(id => id !== H); if (!anchor) return true;
      const dx = b.get(anchor).x-a.get(anchor).x, dy = b.get(anchor).y-a.get(anchor).y;
      return mol.atoms.filter(id => id !== H).every(id => Math.abs((b.get(id).x-a.get(id).x)-dx)<1e-5 && Math.abs((b.get(id).y-a.get(id).y)-dy)<1e-5);
    });
  };
  const curves = async () => {
    const c = await context(), owners = new Map(c.molecules.flatMap(mol => mol.atoms.map(id => [id,mol.id]))), ctx = controller.ctx();
    const endpoint = ep => ep.type === 'bond' ? (() => { const b=ctx.bondInfo(ep.bondId);return b?[b.beginAtom,b.endAtom]:[]; })() : M.endpointAtomIds(ep);
    return model.state.arrows.map(arrow => {
      const g=M.arrowGeometry(arrow,ctx), refs=[...endpoint(arrow.source),...endpoint(arrow.target)], scene=R.buildScene(ctx,model);
      R.addArrowObstacles(scene,model,ctx,arrow.id);
      const p=R.planArrow({a:g.routingStart||g.start,b:g.routingEnd||g.end,scene,source:arrow.source,target:arrow.target,electronCount:arrow.electronCount,fixedGeometry:g});
      const q=R.assessReadability({...g,L:scene.L,intermolecular:new Set(refs.map(id=>owners.get(id))).size>1});
      return {id:arrow.id,ok:!!g.sourceOk&&!!g.targetOk&&!g.degenerate&&!!p.feasible&&!!q.readable&&!p.ranked[0]?.arrowHits};
    });
  };
  const before = await context(), initial = oriented(before);
  check('historical crowded fixture has expected atoms, steps, flows and target', before.atoms.length===231 && before.reactionSteps.length===12 && before.arrows.length===27 && !!initial, {counts:[before.atoms.length,before.reactionSteps.length,before.arrows.length],initial});
  const ops = [
    { id:'orient-existing-oh', type:'molecule.move', target:{atoms:[H]}, orientTowardAtomId:target },
    { id:'aim-proton-pair', type:'lonePair.modify', lonePairId:pair, aim:'auto' },
    { id:'reroute-proton-flow', type:'arrow.modify', arrowId:flow, mode:'auto' },
  ];
  await api.beginRun('orient-hydrogen');
  const beforeHistory=history(), preview = await api.previewOperations(ops,{runId:'orient-hydrogen'}), afterPreview=await context();
  check('preview does not mutate chemistry, coordinates or native history', preview.previewed===ops.length && chemistry(afterPreview)===chemistry(before) && coords(afterPreview)===coords(before) && canonical(history())===canonical(beforeHistory), {preview,history:history()});
  const receipt=await api.applyOperations(ops,{runId:'orient-hydrogen'}), after=await context(), aimed=oriented(after);
  const moved=receipt.updated?.find(item=>item.id==='orient-existing-oh');
  check('orientation receipt identifies the original parent, target and conserved bond length',
    moved?.parentAtomId===initial.parentId && moved?.towardAtomId===target &&
    Math.abs(moved.bondLengthBefore-initial.length)<1e-5 && Math.abs(moved.bondLengthAfter-initial.length)<1e-5 &&
    Number.isFinite(moved.displacement?.dx) && Number.isFinite(moved.displacement?.dy), moved);
  check('orientation keeps original O–H length and aims at the existing target', aimed && aimed.parentId===initial.parentId && Math.abs(aimed.length-initial.length)<1e-5 && aimed.cosine>0.99999, {initial,aimed});
  check('all molecular and electron-flow identities and chemistry survive', chemistry(after)===chemistry(before));
  check('every other atom keeps its intra-molecule coordinates; whole routes may translate', translatedMolecules(before,after));
  check('the original donor pair is explicitly rebound and original flow retained', after.lonePairs.find(p=>p.id===pair)?.refAtomId===H && after.arrows.some(a=>a.id===flow));
  check('one native history entry contains the full orientation batch', history().undo===beforeHistory.undo+1, {beforeHistory,after:history()});
  const assessed=await curves();
  check('all 27 actual flows retain valid endpoints and readable unobstructed geometry', assessed.length===27 && assessed.every(a=>a.ok), assessed.filter(a=>!a.ok));
  check('every reaction step still passes native layout checks', after.reactionSteps.every(step=>step.checks?.layout?.status==='passed'), after.reactionSteps.filter(step=>step.checks?.layout?.status!=='passed'));
  samples.after=await k3dAPI.serializeWorkbench(); const afterCoords=coords(after), afterChem=chemistry(after);
  await api.endRun('orient-hydrogen'); k3dAPI.undo(); const undone=await context();
  check('one undo restores original coordinates and stable chemistry', coords(undone)===coords(before) && chemistry(undone)===chemistry(before));
  k3dAPI.redo(); const redone=await context();
  check('one redo restores orientation and stable chemistry', coords(redone)===afterCoords && chemistry(redone)===afterChem);
  const loaded=await k3dAPI.loadWorkbench(samples.after), reopened=await context(), again=oriented(reopened);
  check('save and reopen preserve chemistry, IDs, bond length and aiming', loaded.ok && chemistry(reopened)===afterChem && again && Math.abs(again.length-initial.length)<1e-5 && again.cosine>0.99999, {loaded,again});
  const image=await k3dAPI.exportMechanismImage('png'); if(image.ok) samples.png=image.dataUrl;
  // Non-hydrogen targets must be rejected without committing any edit.
  await api.beginRun('orient-guard'); const guardBefore=await context(), guardHistory=history();
  let rejected;try { await api.applyOperations([{id:'reject-heavy',type:'molecule.move',target:{atoms:[target]},orientTowardAtomId:H}],{runId:'orient-guard'}); } catch (error) { rejected={code:error.code,message:error.message}; }
  const guardAfter=await context();
  check('orientation rejects a heavy-atom target without mutation or history', rejected?.code==='hydrogen_orientation_unsupported' && chemistry(guardAfter)===chemistry(guardBefore) && coords(guardAfter)===coords(guardBefore) && canonical(history())===canonical(guardHistory), rejected);
  await api.endRun('orient-guard');
  await k3dAPI.setMolecule(''); ed.clearHistory(); await api.beginRun('stereo-seed');
  const stereoSeed=await api.applyOperations([
    {id:'chiral-substrate',type:'molecule.add',smiles:'[H:1][C@:2]([F:3])([Cl:4])[Br:5]',x:0,y:0},
    {id:'stereo-destination',type:'molecule.add',smiles:'[O-:1]',x:8,y:0},
  ],{runId:'stereo-seed'});
  await api.endRun('stereo-seed'); await api.beginRun('stereo-guard');
  const stereoBefore=await context(), stereoHistory=history(); let stereoError;
  try { await api.applyOperations([{id:'reject-stereo',type:'molecule.move',target:{atoms:[stereoSeed.atomMapping['chiral-substrate:1']]},orientTowardAtomId:stereoSeed.atomMapping['stereo-destination:1']}],{runId:'stereo-guard'}); }
  catch(error){stereoError={code:error.code,message:error.message};}
  const stereoAfter=await context();
  check('orientation rejects a stereochemical parent without touching atoms, bonds or history', stereoError?.code==='hydrogen_orientation_stereo' &&
    chemistry(stereoAfter)===chemistry(stereoBefore) && coords(stereoAfter)===coords(stereoBefore) && canonical(history())===canonical(stereoHistory), stereoError);
  await api.endRun('stereo-guard');
  return {checks,samples,receipt};
}

app.whenReady().then(async () => {
  win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.service+'/canvas.html');
    for(let i=0;i<400;i++){if(await js('!!window.k3dAPI?.workbenchReady?.()'))break;await new Promise(r=>setTimeout(r,80));}
    await js('k3dAPI.agent.getContext()');
    const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(SOURCE)+')'); if(!loaded.ok)throw new Error('fixture load failed: '+JSON.stringify(loaded));
    await js('MolWorkbench.app.adapter.ed.clearHistory(); void 0');
    const result=await js('('+exercise.toString()+')()');report.checks=result.checks;report.ok=report.checks.every(c=>c.pass);
    fs.writeFileSync(path.join(OUT,'oriented.molwork'),result.samples.after);
    if(result.samples.png)fs.writeFileSync(path.join(OUT,'oriented.png'),Buffer.from(result.samples.png.split(',')[1],'base64'));
    fs.writeFileSync(path.join(OUT,'window.png'),(await win.capturePage()).toPNG());
  } catch(error) {
    report.ok=false;report.error=String(error.stack||error);
    try { report.checks=await js('window.orientChecks||[]'); fs.writeFileSync(path.join(OUT,'failed.png'),(await win.capturePage()).toPNG()); } catch(_) {}
  } finally {
    write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,total:report.checks.length,error:report.error,out:OUT},null,2));win.destroy();app.exit(report.ok?0:1);
  }
});
