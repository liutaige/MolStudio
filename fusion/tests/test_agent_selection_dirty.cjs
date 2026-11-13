'use strict';
// Node: scoped nonmutating snapshot tests. Electron: actual selection/hover/
// charge regression using a private service/profile, never the user's app.
if (!process.versions.electron) {
  const {test}=require('node:test');
  const assert=require('node:assert/strict');
  require('../workbench/mechanism-model.js');require('../workbench/workbench-storage.js');
  const storage=globalThis.MolWorkbench.storage;
  test('full workbench snapshot ignores native KET UI selection without changing source or business metadata',()=>{
    const ket={root:{selected:'root metadata',nodes:[{$ref:'mol0',selected:true},{type:'text',selected:true,paragraphs:[{parts:[{text:'文字 selected initiallySelected'}],selected:true}],extension:{selected:true}}]},
      mol0:{type:'molecule',selected:true,atoms:[{label:'C',location:[0,0,0],selected:true,initiallySelected:false,queryProperties:{selected:true},extension:{initiallySelected:true}}],bonds:[],metadata:{selected:true,initiallySelected:true}},
      extension:{type:'custom',selected:true,initiallySelected:true}};
    const original=JSON.stringify(ket),result=JSON.parse(storage.serializeWorkbench({ket})).ket;
    assert.equal(JSON.stringify(ket),original,'caller-owned KET is not mutated');
    assert.equal(result.mol0.atoms[0].selected,undefined);assert.equal(result.mol0.atoms[0].initiallySelected,undefined);
    assert.equal(result.mol0.selected,undefined);assert.equal(result.root.nodes[0].selected,undefined);assert.equal(result.root.nodes[1].selected,undefined);
    assert.deepEqual(result.mol0.metadata,ket.mol0.metadata);assert.deepEqual(result.extension,ket.extension);
    assert.equal(result.root.selected,'root metadata');assert.deepEqual(result.mol0.atoms[0].queryProperties,{selected:true});
    assert.deepEqual(result.mol0.atoms[0].extension,{initiallySelected:true});assert.deepEqual(result.root.nodes[1].extension,{selected:true});
    assert.equal(result.root.nodes[1].paragraphs[0].selected,true,'arbitrary rich-text dictionaries are preserved');
    assert.equal(storage.serializeWorkbench({ket:original}),storage.serializeWorkbench({ket}),'string and object inputs share snapshot semantics');
  });
  test('chemical values, native geometry and nonboolean same-name data remain significant',()=>{
    const ket={root:{nodes:[{$ref:'mol0'},{type:'arrow',data:{mode:'open-angle',pos:[{x:0,y:0},{x:1,y:0}],selected:true}}]},mol0:{type:'molecule',atoms:[{label:'O',location:[0,0,0],charge:-1,selected:'business-string'}],bonds:[]}};
    const clean=JSON.parse(storage.serializeWorkbench({ket})).ket;
    assert.equal(clean.mol0.atoms[0].charge,-1);assert.equal(clean.mol0.atoms[0].selected,'business-string');
    assert.deepEqual(clean.root.nodes[1].data.pos,ket.root.nodes[1].data.pos);assert.equal(clean.root.nodes[1].data.selected,undefined);
    const initial=storage.serializeWorkbench({ket});const changed=structuredClone(ket);changed.mol0.atoms[0].charge=0;
    assert.notEqual(storage.serializeWorkbench({ket:changed}),initial);
  });
} else {
  const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
  const OUT=path.resolve(__dirname,'../../.jez/artifacts/agent-selection-dirty-validation');fs.mkdirSync(OUT,{recursive:true});
  app.setPath('userData',path.join(OUT,'electron-profile'));
  const wait=ms=>new Promise(r=>setTimeout(r,ms)),timer=setTimeout(()=>app.exit(2),60000);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{offscreen:true,backgroundThrottling:false}});
    try {
      await win.loadURL('http://127.0.0.1:'+(process.env.MOLSTUDIO_PORT||48973)+'/canvas.html');
      const js=code=>win.webContents.executeJavaScript(code);
      for(let i=0;i<200;i++){if(await js('!!window.k3dAPI?.workbenchReady?.()'))break;await wait(100);}
      const fixture=fs.readFileSync(path.join(__dirname,'fixtures/C01.ket'),'utf8');
      await js('k3dAPI.setMolecule('+JSON.stringify(fixture)+')');await wait(500);
      const report=await js(`(async()=>{
        const checks=[],test=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});
        const a=MolWorkbench.app.adapter,ed=a.ed,wait=ms=>new Promise(r=>setTimeout(r,ms));
        await a.doc.fonts?.ready;ed.selection(null);
        const baseline=await k3dAPI.serializeWorkbench(),rawBefore=JSON.parse(await k3dAPI.getKet());
        ed.selection('all');const rawAfter=JSON.parse(await k3dAPI.getKet()),selected=await k3dAPI.serializeWorkbench();
        const differences=[];
        function diff(x,y,path='ket'){if(JSON.stringify(x)===JSON.stringify(y))return;if(x&&y&&typeof x==='object'&&typeof y==='object'){for(const key of new Set([...Object.keys(x),...Object.keys(y)]))diff(x[key],y[key],path+'.'+key);}else differences.push({path,before:x,after:y});}
        diff(rawBefore,rawAfter);
        test('native select-all changes raw getKet UI fields and retains the real selection',differences.length>0&&a.selection().atoms.length>0,differences);
        test('native select-all leaves full saved workbench snapshot identical',baseline===selected);
        const atom=Array.from(ed.struct().atoms.keys())[0];ed.hover({map:'atoms',id:atom});await wait(80);
        test('native hover does not mark the saved workbench dirty',baseline===await k3dAPI.serializeWorkbench());
        ed.hover(null);ed.selection(null);test('clearing selection and hover also preserves snapshot',baseline===await k3dAPI.serializeWorkbench());
        await k3dAPI.setMolecule('CCO');await wait(350);ed.selection(null);const beforeCharge=await k3dAPI.serializeWorkbench();
        const oxygen=Array.from(ed.struct().atoms.values()).find(atom=>atom.label==='O');oxygen.charge=-1;ed.update(true);
        const afterCharge=await k3dAPI.serializeWorkbench();
        test('actual chemical charge edit still changes full saved snapshot',beforeCharge!==afterCharge&&JSON.parse(afterCharge).ket.mol0.atoms.some(atom=>atom.label==='O'&&atom.charge===-1));
        return {checks,differences};
      })()`);
      fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
      const failures=report.checks.filter(check=>!check.pass);console.log(JSON.stringify({passed:report.checks.length-failures.length,total:report.checks.length,failures,differences:report.differences},null,2));
      process.exitCode=failures.length?1:0;
    }catch(error){console.error(error);process.exitCode=1;}
    finally{clearTimeout(timer);win.destroy();app.exit(process.exitCode||0);}
  });
}
