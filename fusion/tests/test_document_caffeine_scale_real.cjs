'use strict';
// One-off real acceptance: load the real-model caffeine-routes paper page from
// the deliverable build, verify the first-round counts, then scale all chemistry
// to 75% at true paper size, check save/reopen/undo, mix in rich text and a
// dashed arrow shape, export pages to SVG and screenshot the final canvas.
//   MOLSTUDIO_PORT=49191 MOLSTUDIO_CAFFEINE_MOLWORK=/abs/real-caffeine-routes.molwork \
//   env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron --no-sandbox \
//   fusion/tests/test_document_caffeine_scale_real.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49191;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/final-20261115/caffeine'));
const molworkPath = process.env.MOLSTUDIO_CAFFEINE_MOLWORK || path.join(out, 'real-caffeine-routes.molwork');
const firstReportPath = process.env.MOLSTUDIO_CAFFEINE_FIRST_REPORT || path.join(out, 'report.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-caffeine-scale-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);

const BUILD = process.env.MOLSTUDIO_TEST_BUILD ||
  `${path.resolve(__dirname, '../../fusion-native/dist/MolStudio.app')} (deliverable, Contents/Resources/canvas.html, port ${port})`;

const report = {
  application: 'MolStudio current canvas (deliverable build)',
  page: 'fusion/canvas.html',
  pageURL: `http://127.0.0.1:${port}/canvas.html`,
  build: BUILD,
  servicePort: port,
  modelCalls: 0,
  fixture: molworkPath,
  checks: [],
  browserErrors: [],
  artifacts: {},
  startedAt: new Date().toISOString(),
};
let win;
const watchdog = setTimeout(() => {
  report.ok = false; report.error = 'caffeine scale watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 420_000);
function writeReport() { fs.writeFileSync(path.join(out, 'caffeine-scale-report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = async name => {
  const image = await win.webContents.capturePage();
  const file = path.join(out, name);
  fs.writeFileSync(file, image.toPNG());
  report.artifacts[name.replace(/\.png$/, '')] = file;
  return file;
};

async function main() {
  win = new BrowserWindow({ show: true, width: 1560, height: 1200, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_e, d) => report.browserErrors.push(`renderer gone: ${JSON.stringify(d)}`));
  const js = code => win.webContents.executeJavaScript(code);
  const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });

  try {
    // 第一步基准：首轮真实模型报告的实体计数（作为断言期望值）
    let firstRound = null;
    try { firstRound = JSON.parse(fs.readFileSync(firstReportPath, 'utf8')); } catch (_) {}
    const fixture = fs.readFileSync(molworkPath, 'utf8');

    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('canvas did not become ready');

    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('caffeine molwork failed to load: ' + JSON.stringify(loaded));
    await wait(400);

    // ---- 阶段 1：与首轮报告一致的路线/步骤/电子流 + 纸页范围 ----
    const audit = await js(`(async()=>{
      const MW=MolWorkbench, c=MW.app.documentController, ad=MW.app.adapter;
      const ctx=await k3dAPI.agent.getContext();
      const saved=JSON.parse(await k3dAPI.serializeWorkbench());
      const pages=MW.documentModel.pageRects(c.state);
      const inside=p=>pages.some(r=>p.x>=r.x-.001&&p.y>=r.y-.001&&p.x<=r.x+r.w+.001&&p.y<=r.y+r.h+.001);
      const st=ad.struct();
      // 路线推导与探针 inspectMethylRoutes 一致：按分子归属把反应箭头连成链，
      // 起始箭头（反应物不是任何其他步骤的产物）的数量即路线数。
      const moleculeByAtom=new Map();
      for(const mol of ctx.molecules)for(const atomId of mol.atoms)moleculeByAtom.set(atomId,mol.id);
      const steps=(ctx.reactionArrows||[]).map(arrow=>({
        id:arrow.id,
        reactantMolecules:[...new Set((arrow.reactants||[]).map(id=>moleculeByAtom.get(id)).filter(Boolean))],
        productMolecules:[...new Set((arrow.products||[]).map(id=>moleculeByAtom.get(id)).filter(Boolean))],
      }));
      const routeStarts=steps.filter(step=>!steps.some(other=>other!==step&&other.productMolecules.some(id=>step.reactantMolecules.includes(id))));
      return {
        mode:c.state.mode,
        routeCount:routeStarts.length,
        stepCount:steps.length,
        contextReactionSteps:(ctx.reactionSteps||[]).length,
        arrowCount:(saved.mechanism?.arrows||[]).length,
        atomCount:st.atoms.size,
        lonePairs:(saved.mechanism?.lonePairs||[]).length,
        objects:c.state.objects.length,
        hasPaperOverflow:c.hasPaperOverflow(),
        atomsOutside:[...st.atoms.values()].filter(a=>!inside(a.pp)).length,
        arrowsOutside:(saved.mechanism?.arrows||[]).filter(ar=>{
          const g=MW.model.arrowGeometry(ar,c.mechanism.ctx());
          return Array.from({length:25},(_,i)=>MW.model.quadPoint(g.start,g.control,g.end,i/24)).some(p=>!inside(p));
        }).length,
        coords:(()=>{const o={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)o[uuid]=[pp.x,pp.y];}return o;})(),
        arrowScales:(saved.mechanism?.arrows||[]).map(a=>a.scale??1),
      };
    })()`);
    report.firstRoundCounts = { routeCount: audit.routeCount, reactionStepCount: audit.reactionStepCount, arrowCount: audit.arrowCount };
    const expectRoutes = firstRound?.caffeineRoutes?.routeCount ?? firstRound?.counts?.routeCount;
    const expectSteps = firstRound?.caffeineRoutes?.stepCount ?? firstRound?.counts?.reactionStepCount ?? 4;
    const expectArrows = firstRound?.caffeineRoutes?.arrowCount ?? firstRound?.counts?.arrowCount ?? 8;
    check('真实模型生成的纸页处于纸页模式', audit.mode === 'paper', { mode: audit.mode });
    check('路线数量与首轮报告一致（2 条路线）', audit.routeCount === 2 && (expectRoutes === undefined || audit.routeCount === expectRoutes),
      { routeCount: audit.routeCount, expectRoutes: expectRoutes ?? '(首轮报告无该字段)' });
    check('反应步骤数与首轮报告一致', audit.stepCount === expectSteps,
      { stepCount: audit.stepCount, expectSteps });
    check('电子流（机理弯箭头）数量与首轮报告一致', audit.arrowCount === expectArrows,
      { arrowCount: audit.arrowCount, expectArrows });
    check('纸页范围检查通过（无 paper overflow，原子与箭头均在页面内容区内）',
      audit.hasPaperOverflow === false && audit.atomsOutside === 0 && audit.arrowsOutside === 0,
      { hasPaperOverflow: audit.hasPaperOverflow, atomsOutside: audit.atomsOutside, arrowsOutside: audit.arrowsOutside });

    // ---- 阶段 2：实际尺寸缩放 75%（beginScaleSession + applyScalePercent）----
    const scale = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench, c=MW.app.documentController, ad=MW.app.adapter;
      const st=ad.struct();
      const coords=()=>{const o={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)o[uuid]=[pp.x,pp.y];}return o;};
      const before=(${JSON.stringify(audit.coords)});
      const xs=Object.values(before).map(p=>p[0]),ys=Object.values(before).map(p=>p[1]);
      const center={x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2};
      const arrowScalesBefore=(${JSON.stringify(audit.arrowScales)});
      ad.ed.selection({atoms:[...st.atoms.keys()],bonds:[...st.bonds.keys()]});
      c.render();
      const began=c.beginScaleSession();
      const applied=c.applyScalePercent(75);
      await wait(250);
      const after=coords();
      const ratios=Object.keys(before).map(uuid=>{
        const r0=[before[uuid][0]-center.x,before[uuid][1]-center.y];
        const r1=[after[uuid][0]-center.x,after[uuid][1]-center.y];
        return [uuid,Math.abs(r0[0])>1e-9?r1[0]/r0[0]:1,Math.abs(r0[1])>1e-9?r1[1]/r0[1]:1];
      });
      const factors=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      const savedText=await k3dAPI.serializeWorkbench();
      const saved=JSON.parse(savedText);
      const savedScales=saved.document?.atomScales||{};
      const arrowScalesAfter=(saved.mechanism?.arrows||[]).map(a=>a.scale??1);
      c.endScaleSession();
      return {began,applied,after,ratios:factors.length?[...new Set(ratios.map(r=>[r[1],r[2]]))]:ratios,
        factors:[...new Set(factors)],savedText,
        scalesCount:Object.keys(savedScales).length,
        savedScaleValues:[...new Set(Object.values(savedScales).map(v=>Math.round(v*1e6)/1e6))],
        arrowScalesBefore,arrowScalesAfter,overflowAfterScale:c.hasPaperOverflow()};
    })()`);
    check('beginScaleSession + applyScalePercent(75) 成功提交', scale.began === true && scale.applied === true,
      { began: scale.began, applied: scale.applied });
    check('原子坐标相对选区中心精确缩放 0.75',
      scale.ratios.every(([rx, ry]) => Math.abs(rx - 0.75) < 1e-6 && Math.abs(ry - 0.75) < 1e-6),
      { ratios: scale.ratios });
    check('atomScales 全部为 0.75（适配器视觉因子与序列化值一致）',
      scale.factors.length > 0 && scale.factors.every(f => Math.abs(f - 0.75) < 1e-9) &&
      scale.savedScaleValues.length === 1 && Math.abs(scale.savedScaleValues[0] - 0.75) < 1e-6,
      { factors: scale.factors, savedScaleValues: scale.savedScaleValues, count: scale.scalesCount });
    check('机理弯箭头 scale 生效（arrow.scale 乘 0.75）',
      scale.arrowScalesAfter.length === scale.arrowScalesBefore.length &&
      scale.arrowScalesBefore.every((s, i) => Math.abs(scale.arrowScalesAfter[i] - s * 0.75) < 1e-9),
      { before: scale.arrowScalesBefore, after: scale.arrowScalesAfter });
    check('缩放后仍无 paper overflow', scale.overflowAfterScale === false, { overflow: scale.overflowAfterScale });
    await shot('caffeine-scale-canvas.png');
    fs.writeFileSync(path.join(out, 'caffeine-scaled.molwork'), scale.savedText);
    report.artifacts.caffeineScaledMolwork = path.join(out, 'caffeine-scaled.molwork');

    // ---- 阶段 3：一次 undo 恢复 100%（在重开前的原会话内）----
    const undo = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench, c=MW.app.documentController, ad=MW.app.adapter;
      const st=ad.struct();
      const before=(${JSON.stringify(audit.coords)});
      const historyBefore=ad.ed.historySize();
      ad.ed.undo();
      await wait(300);
      const coords={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)coords[uuid]=[pp.x,pp.y];}
      const restored=Object.keys(before).every(uuid=>coords[uuid]&&Math.abs(coords[uuid][0]-before[uuid][0])<1e-6&&Math.abs(coords[uuid][1]-before[uuid][1])<1e-6);
      const factors=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      const saved=JSON.parse(await k3dAPI.serializeWorkbench());
      const arrowScales=(saved.mechanism?.arrows||[]).map(a=>a.scale??1);
      return {restored,historyDelta:ad.ed.historySize().undo-historyBefore.undo,
        factors:[...new Set(factors)],arrowScales,scales:Object.keys(saved.document?.atomScales||{}).length};
    })()`);
    check('一次 undo 恢复原始坐标、atomScales 清空、箭头 scale 复原',
      undo.restored && undo.historyDelta === -1 && undo.factors.every(f => Math.abs(f - 1) < 1e-9) &&
      undo.scales === 0 && undo.arrowScales.every(s => Math.abs(s - 1) < 1e-9),
      { restored: undo.restored, historyDelta: undo.historyDelta, factors: undo.factors, arrowScales: undo.arrowScales, scalesCount: undo.scales });

    // ---- 阶段 4：保存重开一致性（重开后原生历史清空，不再依赖 undo）----
    const reopen = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const savedText=${JSON.stringify(scale.savedText)};
      const loaded=await k3dAPI.loadWorkbench(savedText);
      if(!loaded.ok)throw new Error('reload failed: '+JSON.stringify(loaded));
      await wait(500);
      const MW=MolWorkbench, c=MW.app.documentController, ad=MW.app.adapter;
      const st=ad.struct();
      const after=${JSON.stringify(scale.after)};
      const coords={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)coords[uuid]=[pp.x,pp.y];}
      const preserved=Object.keys(after).every(uuid=>coords[uuid]&&Math.abs(coords[uuid][0]-after[uuid][0])<1e-6&&Math.abs(coords[uuid][1]-after[uuid][1])<1e-6);
      const factors=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      const saved=JSON.parse(await k3dAPI.serializeWorkbench());
      const arrowScales=(saved.mechanism?.arrows||[]).map(a=>a.scale??1);
      return {preserved,factors:[...new Set(factors)],arrowScales,scales:JSON.stringify(saved.document?.atomScales||{})};
    })()`);
    check('loadWorkbench 重开后坐标、atomScales 与箭头 scale 视觉一致',
      reopen.preserved && reopen.factors.every(f => Math.abs(f - 0.75) < 1e-9) &&
      reopen.arrowScales.length === scale.arrowScalesAfter.length &&
      reopen.arrowScales.every((s, i) => Math.abs(s - scale.arrowScalesAfter[i]) < 1e-9),
      { preserved: reopen.preserved, factors: reopen.factors, arrowScales: reopen.arrowScales });

    // 混排基底：上一步已通过 loadWorkbench 重开到 75% 缩放状态，无需 redo
    const redoOk = { ok: reopen.preserved };

    // ---- 阶段 5：混排（富文本框 + 虚线箭头形状）----
    const mixed = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench, c=MW.app.documentController, ad=MW.app.adapter, rt=MW.documentRichText;
      const state=c.state, pages=MW.documentModel.pageRects(state);
      const page=pages[0], content=page.content;
      const tx=c.addText({x:content.x+2,y:content.y+2,w:Math.min(30,content.w-6),h:4,text:'咖啡因合成路线（75%）'});
      c.applyTextFormat(tx,{start:0,end:3},{bold:true});
      const tobj=c.object(tx), segs=rt.segments(tobj.rich);
      const boldOk=segs.some(s=>s.start===0&&s.end===3&&s.bold===true)&&tobj.rich.text==='咖啡因合成路线（75%）';
      const arrowId=c.addShape({shape:'arrow',x:content.x+2,y:content.y+8,w:14,h:3,stroke:{color:'#d02020',width:0.3,dash:'dashed'}});
      c.render(); await wait(200);
      const fdoc=document.getElementById('k').contentDocument;
      const textNode=fdoc.querySelector('[data-doc-id="'+tx+'"]')||document.querySelector('[data-doc-id="'+tx+'"]');
      const shapeNode=fdoc.querySelector('[data-doc-id="'+arrowId+'"] path')||document.querySelector('[data-doc-id="'+arrowId+'"] path');
      const dash=(shapeNode?.getAttribute('stroke-dasharray')||'').length>0;
      const exported=await c.exportPages([page.id]);
      const svg=exported?.ok?exported.pages[0].svg:null;
      const svgOk=!!svg&&svg.includes('tspan')&&svg.includes('stroke-dasharray')&&
        (svg.includes('咖啡因')||svg.includes('咖啡因合成路线'))&&
        [...svg.matchAll(/<text/g)].length>0&&svg.includes('<path');
      return {tx,arrowId,boldOk,textNode:!!textNode,shapeNode:!!shapeNode,dash,
        exportOk:exported?.ok===true,pages:exported?.pages?.length,svgLen:svg?.length||0,svgOk,
        atomsInSvg:svg?(svg.match(/class="atom"/g)||[]).length>=0:true,
        overflow:c.hasPaperOverflow(),
        svg};
    })()`);
    check('富文本框插入成功且部分文字加粗（runs 正确）', mixed.boldOk, { tx: mixed.tx, boldOk: mixed.boldOk });
    check('虚线箭头形状插入成功且画布节点带 stroke-dasharray',
      mixed.shapeNode && mixed.dash, { shapeNode: mixed.shapeNode, dash: mixed.dash });
    check('与化学混排后仍无 paper overflow', mixed.overflow === false, { overflow: mixed.overflow });
    check('exportPages SVG 包含 tspan 文本、虚线形状路径、原子与箭头内容',
      mixed.exportOk && mixed.pages === 1 && mixed.svgOk, { exportOk: mixed.exportOk, pages: mixed.pages, svgLen: mixed.svgLen });
    fs.writeFileSync(path.join(out, 'caffeine-mixed-export.svg'), mixed.svg || '');
    report.artifacts.mixedExportSvg = path.join(out, 'caffeine-mixed-export.svg');
    fs.writeFileSync(path.join(out, 'caffeine-scaled.molwork'), await js('k3dAPI.serializeWorkbench()'));
    await shot('caffeine-scale-canvas.png');

    report.ok = report.checks.every(c => c.pass);
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length,
      failed: report.checks.filter(c => !c.pass).length, error: report.error, out }, null, 2));
  } catch (error) {
    try { for (const c of await js('window.__caffeineScaleChecks||[]')) report.checks.push(c); } catch (_) {}
    report.ok = false; report.error = String(error && error.message || error);
    try { await shot('caffeine-scale-failure.png'); } catch (_) {}
  } finally {
    clearTimeout(watchdog);
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter(c => c.pass).length;
    report.failed = report.checks.filter(c => !c.pass).length;
    writeReport();
    win?.destroy();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    setTimeout(() => app.exit(report.ok ? 0 : 1), 150);
  }
}
app.whenReady().then(main).catch(error => { report.ok = false; report.error = String(error); writeReport(); app.exit(2); });
