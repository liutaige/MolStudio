import Foundation

// Frozen source-page geometry used for conservative PDF Unicode mapping.
let documentPDFGeometryJS = #"""
/* Experimental geometry collection; not used by production export.
   Works in a frozen print page. It mirrors same-document inline SVG and
   nested data-URL SVG images, preserving viewBox transforms. It intentionally
   rejects transformed HTML <img> elements: getBoundingClientRect alone does
   not encode rotation/skew, so guessing would corrupt the source mapping. */
async function collectGlyphGeometry(page){
  const pageRect=page.getBoundingClientRect(), output=[];
  const scale=page.querySelector(':scope > .print-scale');
  // Board items are position:absolute siblings with auto z-index and are painted
  // in DOM order. A standalone SVG likewise follows SVG tree paint order.
  const orderedPaint=page.matches('svg') ? Array.from(page.querySelectorAll('*')).every(e=>getComputedStyle(e).zIndex==='auto') : !!scale && scale.children.length>0 && Array.from(scale.children).every(e=>(e.classList.contains('print-text')||e.classList.contains('print-object'))&&getComputedStyle(e).position==='absolute'&&getComputedStyle(e).zIndex==='auto');
  const isCJK=character=>{const c=character.codePointAt(0);return (c>=0x2e80&&c<=0x2fff)||(c>=0x3400&&c<=0x9fff)||(c>=0xf900&&c<=0xfaff)||(c>=0x20000&&c<=0x3134f)};
  const intersects=r=>r.right>pageRect.left&&r.left<pageRect.right&&r.bottom>pageRect.top&&r.top<pageRect.bottom;
  const visible=el=>{for(let e=el;e&&e!==page.parentElement;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return true;};
  const clipped=(rect,el,stop)=>{for(let e=el;e;e=e.parentElement){const st=getComputedStyle(e),v=st.overflow+' '+st.overflowX+' '+st.overflowY;if(/hidden|clip|scroll|auto/.test(v)){const b=e.getBoundingClientRect();if(rect.right<=b.left||rect.left>=b.right||rect.bottom<=b.top||rect.top>=b.bottom)return true;}if(e===stop)break;}return false;};
  const emit=(character,rect,origin,element,stop,baseline)=>{if(isCJK(character)&&intersects(rect)&&!clipped(rect,element,stop))output.push({character,origin,orderedPaint,x:rect.x-pageRect.x,y:rect.y-pageRect.y,width:rect.width,height:rect.height,...(baseline?{baselineX:baseline.x-pageRect.x,baselineY:baseline.y-pageRect.y}:{})});};
  function htmlText(node){
    if(!visible(node.parentElement))return;let offset=0;
    for(const character of node.data){
      const range=document.createRange();range.setStart(node,offset);offset+=character.length;range.setEnd(node,offset);
      const rects=Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0);
      if(!isCJK(character))continue;
      if(rects.length===1)emit(character,rects[0],'html',node.parentElement,page);
      else if(rects.length>1)throw Error('Character spans multiple rectangles');
    }
  }
  function textRects(root,origin){
    for(const t of root.querySelectorAll('text')){
      if(getComputedStyle(t).display==='none'||getComputedStyle(t).visibility==='hidden')continue;
      const nodes=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);let node,i=0;
      while((node=nodes.nextNode()))for(const character of node.data){
        const style=getComputedStyle(node.parentElement),hidden=style.display==='none'||style.visibility==='hidden';
        if(i>=t.getNumberOfChars()){if(isCJK(character)&&!hidden)throw Error('SVG text indexing is not one-to-one');i+=character.length;continue;}
        if(isCJK(character)&&!hidden){
          const rect=t.getExtentOfChar(i),m=t.getScreenCTM();if(!m)throw Error('SVG has no screen transform');
          const points=[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(m));
          const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),right=Math.max(...xs),bottom=Math.max(...ys);
          const start=t.getStartPositionOfChar(i),baseline=new DOMPoint(start.x,start.y).matrixTransform(m);
          emit(character,{x,y,left:x,top:y,right,bottom,width:right-x,height:bottom-y},origin,node.parentElement,root,baseline);
        }
        i+=character.length;
      }
    }
  }
  async function readSVG(url){
    if(!url?.startsWith('data:image/svg+xml'))throw Error('Only embedded SVG images supported');
    const doc=new DOMParser().parseFromString(await (await fetch(url)).text(),'image/svg+xml');
    if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw Error('Invalid embedded SVG');
    return document.importNode(doc.documentElement,true);
  }
  async function inlineImages(svg,depth=0){
    if(depth>5)throw Error('SVG nesting limit');
    for(const image of Array.from(svg.querySelectorAll('image'))){
      const href=image.getAttribute('href')||image.getAttribute('xlink:href');if(!href?.startsWith('data:image/svg+xml'))continue;
      const nested=await readSVG(href);
      await inlineImages(nested,depth+1);
      for(const name of ['x','y','width','height','transform','opacity','clip-path','mask','preserveAspectRatio','style','class']){
        if(image.hasAttribute(name))nested.setAttribute(name,image.getAttribute(name));
      }
      image.replaceWith(nested);
    }
  }
  async function mirrorSVG(svg){
    if(!visible(svg))return;
    const rect=svg.getBoundingClientRect(),mirror=svg.cloneNode(true);await inlineImages(mirror);
    Object.assign(mirror.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',opacity:'0',pointerEvents:'none',overflow:'hidden',margin:'0'});
    document.body.append(mirror);try{textRects(mirror,'inline-svg');}finally{mirror.remove();}
  }
  async function mirrorImage(image){
    if(!visible(image))return;
    const src=image.currentSrc||image.src;if(!src?.startsWith('data:image/svg+xml'))return;
    const rect=image.getBoundingClientRect();if(!intersects(rect))return;
    if(getComputedStyle(image).transform!=='none')throw Error('Transformed HTML image requires geometric mapping');
    const mirror=await readSVG(src);await inlineImages(mirror);
    Object.assign(mirror.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',opacity:'0',pointerEvents:'none',overflow:'hidden',margin:'0'});
    document.body.append(mirror);try{textRects(mirror,'embedded-svg');}finally{mirror.remove();}
  }
  // Visit in document paint order so overlapping board text and SVG objects can
  // be associated with the PDF's drawing operations without sorting by position.
  async function visit(node){
    if(node.nodeType===Node.TEXT_NODE){htmlText(node);return;}
    if(node.nodeType!==Node.ELEMENT_NODE)return;
    const tag=node.localName;if(tag==='script'||tag==='style')return;
    if(tag==='svg'){await mirrorSVG(node);return;}
    if(tag==='img'){await mirrorImage(node);return;}
    for(const child of node.childNodes)await visit(child);
  }
  await visit(page);
  return output;
}

/* PDFKit rectangles are bottom-left oriented. Coordinates here are the
   original WK capture media box, before any merge transform. The caller must
   exclude synthetic line breaks from PDFKit's character sequence. */
function matchGlyphGeometry(source,pdfBoxes,pageHeight,tolerance=1){
  const available=new Set(pdfBoxes.map((_,i)=>i)), matches=[];
  for(const glyph of source){
    const candidates=[];
    for(const i of available){
      const box=pdfBoxes[i];
      const error=Math.max(Math.abs(glyph.x-box.x),Math.abs(glyph.y-(pageHeight-box.y-box.height)),Math.abs(glyph.width-box.width),Math.abs(glyph.height-box.height));
      if(error<=tolerance)candidates.push({i,error});
    }
    if(candidates.length!==1)throw Error(`Cannot uniquely match ${glyph.origin} glyph ${glyph.character}: ${candidates.length} candidates`);
    const {i,error}=candidates[0];available.delete(i);matches.push({source:glyph,pdf:pdfBoxes[i],error});
  }
  return matches;
}

/* Conservative horizontal-text matching against content-stream baselines.
   Coordinates refer to the same unmerged WK page. Reject overlapping or
   rotated text instead of deriving a character from content-stream order. */
function matchGlyphOrigins(source,drawn,pageHeight,tolerance=1){
  const remaining=new Set(drawn.map((_,i)=>i)),out=[];
  for(const item of source){
    const found=[];
    for(const i of remaining){
      const glyph=drawn[i],x=glyph.x,y=pageHeight-glyph.y;
      if(Math.abs(x-item.x)<=tolerance && y>=item.y-tolerance && y<=item.y+item.height+tolerance)found.push(i);
    }
    if(found.length!==1)throw Error(`Cannot uniquely map ${item.character} to drawn glyph (${found.length} candidates)`);
    const index=found[0];remaining.delete(index);out.push({source:item,drawn:drawn[index]});
  }
  if(remaining.size)throw Error(`${remaining.size} drawn glyphs have no source match`);
  return out;
}

"""#
