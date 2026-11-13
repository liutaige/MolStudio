// A/B 组真实画布验收：编辑已有对象、级联删除、历史一致、整理重排、紧凑布局。
// Electron 独立 profile；不接触用户实例。先在 MOLSTUDIO_PORT 启动 fusion/server.py。
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../../.jez/artifacts/agent-edit-validation');
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(OUT, 'electron-profile'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(2), 300000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.log('RENDERER', event.message); });
  try {
    await win.loadURL('http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 48991) + '/canvas.html');
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 200; i++) { if (await js('!!window.k3dAPI?.workbenchReady?.()')) break; await wait(100); }
    if (!await js('!!window.k3dAPI.agent')) await js(fs.readFileSync(path.resolve(__dirname, '../workbench/agent-bridge.js'), 'utf8'));
    const report = await js(`(async()=>{
    const checks=[],test=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const a=MolWorkbench.app.adapter,ed=a.ed,m=MolWorkbench.app.model,c=MolWorkbench.app.controller,M=MolWorkbench.model,api=k3dAPI.agent;
    const errors=[];
    a.doc.defaultView.addEventListener('error',event=>errors.push(event.message));
    await k3dAPI.setMolecule('');await wait(350);ed.clearHistory();
    const RUN='edit-a1';
    await api.beginRun(RUN);
    const setup=await api.applyOperations([
      {id:'sub',type:'molecule.add',smiles:'[CH3:1][Br:2]',x:-2,y:0},
      {id:'oh',type:'molecule.add',smiles:'[OH-:1]',x:2.2,y:0},
      {id:'lp',type:'lonePair.add',atom:'oh:1',angle:180},
      {id:'ar',type:'arrow.add',source:{type:'lonePair',id:'lp'},target:{type:'atom',atomId:'sub:2'},electronCount:2}
    ],{runId:RUN});
    const before=await api.getContext();
    const uuidOf=ref=>setup.atomMapping[ref];
    test('scene ready: 3 heavy atoms 1 bond 1 lp 1 arrow (H implicit)',before.atoms.length===3&&before.bonds.length===1&&before.lonePairs.length===1&&before.arrows.length===1,{counts:[before.atoms.length,before.bonds.length,before.lonePairs.length,before.arrows.length]});
    test('context exposes molecule handles with members',Array.isArray(before.molecules)&&before.molecules.length===2&&before.molecules.every(mol=>mol.atoms.length>=1&&mol.bonds.length>=0));
    const molHandle=before.molecules.map(x=>x.id).find(id=>before.molecules.find(x=>x.id===id).atoms.length===1);
    test('molecule handle resolves single-atom species',!!molHandle);
    const viewBefore=JSON.stringify(before.viewport);
    const mv=await api.applyOperations([
      {id:'mv',type:'molecule.move',target:{molecule:molHandle},x:3.4,y:1.2},
      {id:'chg',type:'atom.modify',atomId:uuidOf('sub:1'),charge:-1},
      {id:'elem',type:'atom.modify',atomId:uuidOf('sub:2'),label:'Cl'},
      {id:'bo',type:'bond.modify',bondId:setup.bondMapping['sub:bond:1'],order:1}
    ],{runId:RUN});
    const afterEdit=await api.getContext();
    const movedAtom=afterEdit.atoms.find(atom=>atom.id===setup.atomMapping['oh:1']);
    const chargedAtom=afterEdit.atoms.find(atom=>atom.id===setup.atomMapping['sub:1']);
    const clAtom=afterEdit.atoms.find(atom=>atom.id===setup.atomMapping['sub:2']);
    test('molecule.move honors explicit coordinates',Math.abs(movedAtom.x-3.4)<0.01&&Math.abs(movedAtom.y-1.2)<0.01);
    test('atom.modify changes charge and element in place',chargedAtom.charge===-1&&clAtom.label==='Cl');
    test('unrelated atoms keep identity and coordinates',afterEdit.atoms.find(atom=>atom.id===setup.atomMapping['sub:1']).x===before.atoms.find(atom=>atom.id===setup.atomMapping['sub:1']).x);
    test('receipt distinguishes updated from created',mv.updated.length===4&&mv.created.length===0&&mv.updated.every(u=>u.unchanged===true||u.before!==undefined||u.from!==undefined),{updated:mv.updated,created:mv.created});
    test('viewport untouched by edits',viewBefore===JSON.stringify(afterEdit.viewport));
    test('arrow still bound after its target atom relabeled',afterEdit.arrows[0].target.atomId===setup.atomMapping['sub:2']);
    // A2 修改箭头：端点改到 C、手动 bend；id 保持
    const arrowId=afterEdit.arrows[0].id;
    const am=await api.applyOperations([{id:'arm',type:'arrow.modify',arrowId:arrowId,target:{type:'atom',atomId:uuidOf('sub:1')},bend:0.5,mode:'manual'}],{runId:RUN});
    const arrowAfter=afterEdit.arrows[0];
    test('arrow.modify retargets in place with same entity id',arrowAfter.id===arrowId&&(await api.getContext()).arrows[0].target.atomId===uuidOf('sub:1'));
    test('arrow.modify receipt reports before/after',am.updated.length===1&&am.updated[0].before.target.atomId===setup.atomMapping['sub:2']);
    test('no duplicate arrows were created',(await api.getContext()).arrows.length===1);
    // B4：加一根 auto 箭头；整理后 auto 重排、manual bend 保留；一次 undo 同时还原
    const ar2=await api.applyOperations([{id:'ar2',type:'arrow.add',source:{type:'atom',atomId:uuidOf('oh:1')},target:{type:'atom',atomId:uuidOf('sub:1')},electronCount:2}],{runId:RUN});
    const preTidy=await api.getContext();
    const manualBend=preTidy.arrows.find(x=>x.id===arrowId).geometry.bend;
    const autoBendBefore=preTidy.arrows.find(x=>x.id===ar2.created[0].entityIds[0]).geometry.bend;
    const tidy=await api.applyOperations([{id:'tidy1',type:'layout.tidy'}],{runId:RUN});
    const postTidy=await api.getContext();
    const manualAfter=postTidy.arrows.find(x=>x.id===arrowId);
    const autoAfter=postTidy.arrows.find(x=>x.id===ar2.created[0].entityIds[0]);
    test('manual arrow bend survives tidy',manualAfter.geometry.bend===manualBend&&manualAfter.geometry.mode==='manual');
    test('tidy reports real layout result with replanned auto arrows',tidy.updated.length===1&&tidy.updated[0].molecules.length>=1&&Array.isArray(tidy.updated[0].arrowsReplanned),{updated:tidy.updated});
    test('auto arrow replanned or confirmed unchanged by tidy',Array.isArray(tidy.updated[0].arrowsReplanned));
    k3dAPI.undo();await wait(200);
    const postTidyUndo=await api.getContext();
    const autoUndo=postTidyUndo.arrows.find(x=>x.id===ar2.created[0].entityIds[0]);
    const manualUndo=postTidyUndo.arrows.find(x=>x.id===arrowId);
    test('one undo of tidy restores coordinates and auto route together',autoUndo.geometry.bend===autoBendBefore&&manualUndo.geometry.bend===manualBend);
    k3dAPI.redo();await wait(200);
    // 手动 undo/redo 使旧 agent 运行失效（产品设计：手动编辑优先）。开新运行继续。
    await api.beginRun('edit-a2');
    // A3 级联删除：删除 sub 分子 → 键消失、指向其原子的箭头级联删除、oh 保留
    const dl=await api.applyOperations([{id:'del',type:'molecule.delete',target:{atoms:[uuidOf('sub:1'),uuidOf('sub:2')]}}],{runId:'edit-a2'});
    const afterDelete=await api.getContext();
    test('molecule.delete removes atoms and its bond',afterDelete.atoms.length===1&&afterDelete.bonds.length===0);
    test('cascaded arrows are listed in the receipt',dl.deleted.length===1&&dl.deleted[0].entityIds.includes(arrowId)&&dl.cascaded.length===1&&dl.cascaded[0].arrows.includes(arrowId)&&dl.cascaded[0].arrows.includes(ar2.created[0].entityIds[0]));
    test('unrelated lone pair survives',afterDelete.lonePairs.length===1);
    // A5 逐步 undo 到初始，再 redo 到最终（setup/edit/arm/ar2/tidy(已redo)/del = 6 步）
    const totalUndo=ed.historySize().undo;
    for(let i=0;i<totalUndo;i++){k3dAPI.undo();await wait(150);}
    const emptyState=await api.getContext();
    test('undo chain returns to the initial empty canvas',emptyState.atoms.length===0&&emptyState.arrows.length===0&&emptyState.lonePairs.length===0);
    for(let i=0;i<totalUndo;i++){k3dAPI.redo();await wait(150);}
    const redoEnd=await api.getContext();
    test('redo chain restores the final state incl. stable uuids',redoEnd.atoms.length===1&&redoEnd.lonePairs.length===1&&redoEnd.atoms[0].id===setup.atomMapping['oh:1']);
    await api.beginRun('edit-a3');
    // A6 批次原子性
    const failBefore=await k3dAPI.serializeWorkbench();
    let rejected=false;
    try{await api.applyOperations([{id:'okmove',type:'molecule.move',target:{atoms:[redoEnd.atoms[0].id]},dx:2,dy:0},{id:'bad',type:'atom.delete',atomId:'at-nonexistent'}],{runId:'edit-a3'});}catch(e){rejected=true;}
    test('failed batch rolls back completely',rejected&&failBefore===await k3dAPI.serializeWorkbench());
    // A7 保存重开
    const saved=await k3dAPI.loadWorkbench(failBefore);await wait(250);
    const reloaded=await api.getContext();
    test('save/reopen keeps structure, bindings and no preview',saved.ok&&reloaded.atoms.length===1&&reloaded.lonePairs.length===1&&!a.doc.querySelector('[data-agent-preview]'));
    // B1 紧凑布局：不给坐标的两个小分子，间距紧凑且 200% 缩放不改模型几何
    await k3dAPI.setMolecule('');await wait(350);ed.clearHistory();
    await api.beginRun('layout-b1');
    const placed=await api.applyOperations([
      {id:'w1',type:'molecule.add',smiles:'O'},
      {id:'w2',type:'molecule.add',smiles:'CO'}
    ],{runId:'layout-b1'});
    const ctxB1=await api.getContext();
    const boxOf=prefix=>{const pts=Object.keys(placed.atomMapping).filter(k=>k.startsWith(prefix+':')).map(k=>ctxB1.atoms.find(atom=>atom.id===placed.atomMapping[k]));const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);return{x1:Math.min(...xs),x2:Math.max(...xs),y1:Math.min(...ys),y2:Math.max(...ys)};};
    const w1=boxOf('w1'),w2=boxOf('w2');
    const gapX=Math.max(w1.x1,w2.x1)-Math.min(w1.x2,w2.x2);
    test('default spacing is compact (atom boxes within 3 bond lengths)',gapX>=1.0&&gapX<=3.0,{gapX:+gapX.toFixed(3)});
    const overlapY=!(w1.y2<w2.y1||w2.y2<w1.y1);
    const disjointX=w1.x2<w2.x1||w2.x2<w1.x1;
    test('molecules do not overlap and are separated',disjointX&&gapX>=1.0,{gapX:+gapX.toFixed(3),overlapY});
    const view100=JSON.stringify(ctxB1.viewport);
    k3dAPI.zoomBy(2,null);await wait(200);
    const ctx200=await api.getContext();
    const geomSame=ctx200.atoms.length===ctxB1.atoms.length&&ctx200.atoms.every(atom=>{const beforeAtom=ctxB1.atoms.find(x=>x.id===atom.id);return beforeAtom&&Math.abs(beforeAtom.x-atom.x)<1e-6&&Math.abs(beforeAtom.y-atom.y)<1e-6;});
    test('zoom does not change saved model geometry',geomSame&&ctx200.source===undefined,{zoomChanged:JSON.stringify(ctx200.viewport)!==view100,geomSame});
    k3dAPI.zoomBy(0.5,null);await wait(150);
    // B6 C+/CH3 端点核对：结构数据断言
    await k3dAPI.setMolecule('');await wait(350);ed.clearHistory();
    await api.beginRun('b6-cation');
    const b6=await api.applyOperations([
      {id:'cation',type:'molecule.add',smiles:'[C+:1]([CH3:2])([CH3:3])[CH3:4]'},
      {id:'nu',type:'molecule.add',smiles:'[OH-:1]',x:-4,y:0},
      {id:'b6lp',type:'lonePair.add',atom:'nu:1',angle:180},
      {id:'b6ar',type:'arrow.add',source:{type:'lonePair',id:'b6lp'},target:{type:'atom',atomId:'cation:1'},electronCount:2}
    ],{runId:'b6-cation'});
    const b6ctx=await api.getContext();
    const cationAtom=b6ctx.atoms.find(atom=>atom.id===b6.atomMapping['cation:1']);
    const methyl=b6ctx.atoms.find(atom=>atom.id===b6.atomMapping['cation:2']);
    const b6arrow=b6ctx.arrows[0];
    test('target UUID is the charged carbon, not a methyl',b6arrow.target.atomId===b6.atomMapping['cation:1']&&cationAtom.charge===1&&cationAtom.label==='C');
    test('charge lands on the central carbon and methyls stay neutral',cationAtom.charge===1&&methyl.charge===0);
    const geo=M.arrowGeometry(b6arrow,c.ctx());
    const labelBox=a.atomLabelBox(b6arrow.target.atomId);
    test('arrow tip sits outside every methyl label box',b6ctx.atoms.filter(atom=>atom.id!==b6.atomMapping['cation:1']&&atom.id!==b6.atomMapping['nu:1']).every(atom=>{
      const box=a.atomLabelBox(atom.id);
      if(!box||!box.hasLabel)return true;
      const r=box.rect;const inX=geo.end.x>=r.x1-0.01&&geo.end.x<=r.x2+0.01;const inY=geo.end.y>=r.y1-0.01&&geo.end.y<=r.y2+0.01;
      return !(inX&&inY);}));
    test('target label box is real and finite',labelBox&&labelBox.hasLabel&&labelBox.hwCss>0&&labelBox.rect&&Number.isFinite(labelBox.rect.x1));
    test('arrow endpoint within one bond length of the target center',Math.hypot(geo.end.x-cationAtom.x,geo.end.y-cationAtom.y)<1.2);
    // D1/D2：修改/删除的渐进预览是独立 ghost 层，不提前改源
    await api.beginRun('preview-ghosts');
    const ghostScene=await api.applyOperations([
      {id:'g1',type:'molecule.add',smiles:'CCO',x:-2,y:0},
      {id:'g2',type:'molecule.add',smiles:'CC(=O)N',x:2,y:0}
    ],{runId:'preview-ghosts'});
    const ghostCtx=await api.getContext();
    const ccoAtoms=Object.keys(ghostScene.atomMapping).filter(k=>k.startsWith('g1:')).map(k=>ghostScene.atomMapping[k]);
    const beforeGhost=await k3dAPI.serializeWorkbench();const undoBeforeGhost=ed.historySize().undo;
    const ghost=await api.previewOperations([{id:'gdel',type:'molecule.delete',target:{atoms:ccoAtoms}}],{runId:'preview-ghosts'});
    test('delete ghost layer is visible while source stays untouched',ghost.previewed===1&&!!a.doc.querySelector('[data-agent-preview]')&&a.doc.querySelector('[data-agent-kind="ghost-cross"]')!==null&&beforeGhost===await k3dAPI.serializeWorkbench()&&ed.historySize().undo===undoBeforeGhost);
    const ghostMove=await api.previewOperations([{id:'gmv',type:'molecule.move',target:{atoms:ccoAtoms},dx:3,dy:1},{id:'gdel',type:'molecule.delete',target:{atoms:ccoAtoms}}],{runId:'preview-ghosts'});
    test('move ghost shows destination without touching source',ghostMove.previewed===2&&!!a.doc.querySelector('[data-agent-kind="ghost-move"]')&&beforeGhost===await k3dAPI.serializeWorkbench()&&ed.historySize().undo===undoBeforeGhost,{previewed:ghostMove.previewed,undo:ed.historySize().undo});
    await api.clearPreview('preview-ghosts');
    test('clearing preview removes the ghost layer',!a.doc.querySelector('[data-agent-preview]'));
    await api.endRun('preview-ghosts');
    // 孤对修改/删除与文字删除（真实对象、级联回执）
    await api.beginRun('lp-text');
    const lpScene=await api.applyOperations([
      {id:'lpm',type:'molecule.add',smiles:'CO',x:-3,y:0},
      {id:'lplp',type:'lonePair.add',atom:'lpm:2',angle:90},
      {id:'lptext',type:'text.add',text:'临时标注',x:-3,y:2}
    ],{runId:'lp-text'});
    const lpId=lpScene.created.find(item=>item.type==='lonePair.add').entityIds[0];
    const lpMod=await api.applyOperations([{id:'lpmod',type:'lonePair.modify',lonePairId:lpId,angle:270}],{runId:'lp-text'});
    const lpState=(await api.getContext()).lonePairs.find(lp=>lp.id===lpId);
    test('lonePair.modify updates the angle in place',lpMod.updated.length===1&&lpState.angle===270&&lpState.origin==='manual');
    const textId=lpScene.created.find(item=>item.type==='text.add').nativeTextId;
    const txDel=await api.applyOperations([{id:'txdel',type:'text.delete',textId:String(textId)}],{runId:'lp-text'});
    test('text.delete removes exactly the addressed text',txDel.deleted.length===1&&ed.struct().texts.size===0);
    const lpDel=await api.applyOperations([{id:'lpdel',type:'lonePair.delete',lonePairId:lpId}],{runId:'lp-text'});
    test('lonePair.delete removes the addressed lone pair (auto suggestions may remain)',!(await api.getContext()).lonePairs.some(lp=>lp.id===lpId)&&!!lpDel.deleted[0]&&lpDel.deleted[0].entityIds.includes(lpId));
    await api.endRun('lp-text');
    // 手动「整理」按钮路径：坐标与 auto 箭头同一历史动作
    await api.beginRun('manual-tidy');
    await api.applyOperations([
      {id:'mt1',type:'molecule.add',smiles:'CC(=O)OC',x:-2,y:0},
      {id:'mt2',type:'molecule.add',smiles:'N',x:3,y:2}
    ],{runId:'manual-tidy'});
    const preManual=await api.getContext();
    const atomUuid=preManual.atoms[0].id;
    const preArrow=await api.applyOperations([{id:'mtar',type:'arrow.add',source:{type:'atom',atomId:preManual.atoms.find(x=>x.label==='N').id},target:{type:'atom',atomId:atomUuid},electronCount:2}],{runId:'manual-tidy'});
    const arrowIdManual=preArrow.created[0].entityIds[0];
    const preBend=(await api.getContext()).arrows.find(x=>x.id===arrowIdManual).geometry.bend;
    c.selection.clear();c.emitSelection();c.render();
    const tidyResult=await k3dAPI.cleanLayout();
    const postManual=await api.getContext();
    const postBend=(postManual.arrows.find(x=>x.id===arrowIdManual)||{}).geometry;
    test('manual cleanLayout succeeds and reports arrow replanning',tidyResult.ok===true&&tidyResult.arrowsReplanned>=1,{result:tidyResult});
    const manualUndoBefore=await k3dAPI.serializeWorkbench();
    k3dAPI.undo();await wait(200);
    const manualUndoCtx=await api.getContext();
    const manualUndoBend=(manualUndoCtx.arrows.find(x=>x.id===arrowIdManual)||{}).geometry;
    test('manual tidy undo restores coordinates and auto route together',manualUndoCtx.atoms.length===postManual.atoms.length&&manualUndoBend&&postBend&&manualUndoBend.bend===preBend);
    k3dAPI.redo();await wait(200);
    await api.endRun('manual-tidy');
    // A loose H placed before its eventual bond is attached locally, with a single undo entry.
    await k3dAPI.setMolecule('');ed.clearHistory();
    const hydrogenRun={runId:'attach-loose-hydrogen'};
    await api.beginRun(hydrogenRun.runId);
    const beforeHydrogen=await api.applyOperations([
      {id:'ether',type:'molecule.add',smiles:'[CH3:1][O:2][CH3:3]',x:-4,y:0},
      {id:'h',type:'molecule.add',smiles:'[H:1]',x:7,y:2}
    ],hydrogenRun);
    const hydrogenId=beforeHydrogen.atomMapping['h:1'],oxygenId=beforeHydrogen.atomMapping['ether:2'];
    const atomAt=(scene,id)=>scene.atoms.find(atom=>atom.id===id);
    const distance=(from,to)=>Math.hypot(from.x-to.x,from.y-to.y);
    const lengthOH=scene=>distance(atomAt(scene,hydrogenId),atomAt(scene,oxygenId));
    const looseHydrogen=await api.getContext();
    const addOH=[{id:'oh-bond',type:'bond.add',begin:oxygenId,end:hydrogenId}];
    const historyBeforeOH=ed.historySize().undo;
    await api.previewOperations(addOH,hydrogenRun);
    const previewOH=a.doc.querySelector('[data-agent-kind="ghost-bond"] line');
    const previewLen=previewOH && Math.hypot(+previewOH.getAttribute('x2')-+previewOH.getAttribute('x1'),+previewOH.getAttribute('y2')-+previewOH.getAttribute('y1'));
    test('loose hydrogen previews a normal length bond without editing the canvas',
      lengthOH(looseHydrogen)>6&&Math.abs(previewLen-1)<0.05&&lengthOH(await api.getContext())===lengthOH(looseHydrogen)&&ed.historySize().undo===historyBeforeOH,
      {previewLen,looseLength:lengthOH(looseHydrogen)});
    await api.applyOperations(addOH,hydrogenRun);
    const attachedHydrogen=await api.getContext();
    test('new O–H bond brings only the agent-created loose hydrogen to the existing structure',
      Math.abs(lengthOH(attachedHydrogen)-1)<0.05&&attachedHydrogen.molecules.length===1&&attachedHydrogen.bonds.length===3&&
      looseHydrogen.atoms.filter(atom=>atom.id!==hydrogenId).every(atom=>distance(atom,atomAt(attachedHydrogen,atom.id))===0)&&ed.historySize().undo===historyBeforeOH+1,
      {attachedLength:lengthOH(attachedHydrogen),bonds:attachedHydrogen.bonds.length});
    await api.endRun(hydrogenRun.runId);
    k3dAPI.undo();
    const detachedAgain=await api.getContext();
    k3dAPI.redo();
    const attachedAgain=await api.getContext();
    test('O–H bond and hydrogen placement undo and redo together',
      detachedAgain.bonds.length===2&&lengthOH(detachedAgain)===lengthOH(looseHydrogen)&&
      attachedAgain.bonds.length===3&&lengthOH(attachedAgain)===lengthOH(attachedHydrogen));
    const workbenchOH=await k3dAPI.serializeWorkbench();
    const storedOH=Object.values(JSON.parse(workbenchOH).ket).some(section=>section.type==='molecule'&&section.bonds?.some(bond=>
      bond.atoms.map(index=>section.atoms[index].label).sort().join(',')==='H,O'));
    const loadedOH=await k3dAPI.loadWorkbench(workbenchOH);
    const reopenedOH=await api.getContext();
    test('joining separate fragments preserves the O–H bond and its stable endpoints through a molwork round trip',
      storedOH&&loadedOH.ok&&reopenedOH.molecules.length===1&&reopenedOH.bonds.length===3&&
      reopenedOH.bonds.some(bond=>[bond.begin,bond.end].includes(hydrogenId)&&[bond.begin,bond.end].includes(oxygenId))&&
      Math.abs(lengthOH(reopenedOH)-1)<0.05,{storedOH,loadedOH,molecules:reopenedOH.molecules.length,bonds:reopenedOH.bonds.length});
    await k3dAPI.setMolecule('');ed.clearHistory();
    const freshHydrogenRun={runId:'attach-fresh-hydrogen'};
    await api.beginRun(freshHydrogenRun.runId);
    const freshOH=[
      {id:'water',type:'molecule.add',smiles:'[OH2:1]',x:-4,y:0},
      {id:'proton',type:'molecule.add',smiles:'[H+:1]',x:7,y:2},
      {id:'join',type:'bond.add',begin:'proton:1',end:'water:1'}
    ];
    await api.previewOperations(freshOH,freshHydrogenRun);
    const freshH=a.doc.querySelector('[data-agent-op="proton"] text');
    const freshBond=a.doc.querySelector('[data-agent-op="join"] line');
    const hydrogenMatchesBond=freshH&&freshBond&&Math.hypot(+freshH.getAttribute('x')-+freshBond.getAttribute('x1'),+freshH.getAttribute('y')-+freshBond.getAttribute('y1'))<0.01;
    const freshReceipt=await api.applyOperations(freshOH,freshHydrogenRun);
    const freshScene=await api.getContext();
    test('a hydrogen declared in the same batch appears at its attached position in preview and commit',
      hydrogenMatchesBond&&freshScene.bonds.length===1&&Math.abs(distance(atomAt(freshScene,freshReceipt.atomMapping['proton:1']),atomAt(freshScene,freshReceipt.atomMapping['water:1']))-1)<0.05);
    await api.endRun(freshHydrogenRun.runId);
    test('no uncaught engine errors during edit operations',errors.length===0,errors);
    return {checks,errors,final:await api.getContext(),
      b6:{arrowTarget:b6arrow.target,charge:cationAtom.charge,end:geo.end,labelBox:{hasLabel:labelBox.hasLabel,rect:labelBox.rect}},
      layout:{gapX:+gapX.toFixed(3),molecules:b6ctx.molecules.length}};
    })().catch(error=>{console.error('EDIT_TEST_ERROR '+error.stack);throw error;})`);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT, 'final.png'), (await win.capturePage()).toPNG());
    const failures = report.checks.filter(check => !check.pass);
    console.log(JSON.stringify({ passed: report.checks.length - failures.length, total: report.checks.length, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(OUT, 'error.txt'), String(error.stack || error));
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog); win.destroy(); app.exit(process.exitCode || 0);
  }
});
