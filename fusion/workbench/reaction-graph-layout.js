/* Pure reaction DAG layout. Coordinates are model units (x right, y down).
 * Each molecule has one home. Reuse across lanes/rows is shown by paired ports,
 * never by duplicating chemical structures or drawing a remote diagonal arrow.
 *
 * plan({ molecules:[{id,width,height,weight?}],
 *   steps:[{id,reactants:[id],products:[id],layout?:{
 *     reactantPlacement:'auto'|'horizontal'|'vertical', breakBefore?:boolean,
 *     conditions?:string }}], anchor?:{x,y}, rowWidth?:37, maxRowWidth?:74,
 *   obstacles?:[{x1,y1,x2,y2}],
 *   groups?:[{id,mainId,moleculeIds:[id],offsets:[{id,x,y}]}],
 *   options?:{stepGap,groupGap,rowGap,routeGap,arrowPadding,minArrowLength,
 *     cueLineHeight,cueWidth,cueGap,obstacleGap,tokenStart} })
 * -> {ok:true, positions:[{id,x,y}], steps:[{id,arrow,flow,ports,links}],
 *     cues:[{token,kind,moleculeIds,ends:[{stepId,role,side,at,x,y}]}],
 *     routes:[...], lanes:[...], bounds:{x1,y1,x2,y2}}
 * -> {ok:false,diagnostic:{code,message,...}}. No partial placement on error.
 *
 * `anchor.x` is the left margin, `anchor.y` the first main molecule's baseline.
 * Groups are rigid: offsets are relative to their main molecule (main = 0,0).
 * A rigid group must fit one semantic stage; conflicting group/step IDs are
 * returned so the caller can release that local grouping and plan again.
 * Cue tokens are display-ready: "续 1" for row wraps, "接 B2" otherwise.
 */
(function (root) {
  'use strict';
  const DEFAULTS = Object.freeze({
    stepGap: 1.85, groupGap: 0.20, rowGap: 2.3, routeGap: 3.2, rowSteps: 5,
    arrowPadding: 0.20, minArrowLength: 0.55, cueLineHeight: 0.65,
    cueWidth: 1.65, cueGap: 0.40, obstacleGap: 0.55, tokenStart: 0,
  });
  const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const unique = xs => [...new Set(xs)];
  const sorted = xs => xs.slice().sort(lexical);
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const point = p => p && finite(p.x) && finite(p.y);
  const middle = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
  const rect = (p, w, h) => ({ x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2 });
  const union = boxes => ({ x1: Math.min(...boxes.map(b => b.x1)), y1: Math.min(...boxes.map(b => b.y1)),
    x2: Math.max(...boxes.map(b => b.x2)), y2: Math.max(...boxes.map(b => b.y2)) });
  const shiftBox = (b, p) => ({ x1: b.x1 + p.x, x2: b.x2 + p.x, y1: b.y1 + p.y, y2: b.y2 + p.y });
  const overlap = (a, b, gap = 0) => a.x1 < b.x2 + gap && a.x2 > b.x1 - gap && a.y1 < b.y2 + gap && a.y2 > b.y1 - gap;
  const textWidth = text => Math.max(0.6, Array.from(text || '').reduce((n, c) => n + (/^[\x20-\x7e]$/.test(c) ? 0.23 : 0.45), 0));
  function reject(code, message, extra) { throw Object.assign(new Error(message), { diagnostic: { code, message, ...extra } }); }
  const invalid = (message, extra) => reject('reaction_graph_invalid_input', message, extra);

  function normalize(input) {
    if (!input || !Array.isArray(input.molecules) || !Array.isArray(input.steps)) invalid('molecules and steps must be arrays');
    if (input.groups !== undefined && !Array.isArray(input.groups)) invalid('groups must be an array');
    if (input.obstacles !== undefined && !Array.isArray(input.obstacles)) invalid('obstacles must be an array');
    if (input.options !== undefined && (!input.options || typeof input.options !== 'object' || Array.isArray(input.options))) invalid('options must be an object');
    const options = { ...DEFAULTS, ...(input.options || {}) };
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!finite(options[key]) || options[key] < 0 || (key !== 'tokenStart' && value > 0 && options[key] <= 0)) invalid('Invalid layout option', { field: 'options.' + key });
    }
    if (!Number.isInteger(options.tokenStart) || !Number.isInteger(options.rowSteps)) invalid('tokenStart and rowSteps must be integers');
    const anchor = input.anchor || { x: 0, y: 0 };
    if (!point(anchor)) invalid('anchor must be finite');
    const rowWidth = input.rowWidth === undefined ? 37 : input.rowWidth;
    const maxRowWidth = input.maxRowWidth === undefined ? 2 * rowWidth : input.maxRowWidth;
    if (!finite(rowWidth) || rowWidth < options.minArrowLength + 2 * options.arrowPadding + options.cueWidth ||
        !finite(maxRowWidth) || maxRowWidth < rowWidth) invalid('Invalid row width');
    const molecules = new Map();
    for (const m of input.molecules) {
      if (!m || typeof m.id !== 'string' || !m.id || molecules.has(m.id) || !finite(m.width) || m.width <= 0 || !finite(m.height) || m.height <= 0 ||
          (m.weight !== undefined && (!finite(m.weight) || m.weight <= 0))) invalid('Invalid or duplicate molecule', { moleculeId: m?.id });
      molecules.set(m.id, { id: m.id, width: m.width, height: m.height, weight: m.weight || 1 });
    }
    const steps = new Map();
    for (const raw of input.steps) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || steps.has(raw.id)) invalid('Invalid or duplicate step', { stepId: raw?.id });
      for (const side of ['reactants', 'products']) {
        if (!Array.isArray(raw[side]) || !raw[side].length || unique(raw[side]).length !== raw[side].length || raw[side].some(id => !molecules.has(id))) {
          invalid('Each step side needs distinct existing molecules', { stepId: raw.id, side });
        }
      }
      if (raw.reactants.some(id => raw.products.includes(id))) reject('reaction_graph_cycle', 'A step cannot consume and produce the same physical molecule', { stepIds: [raw.id] });
      if (raw.layout !== undefined && (!raw.layout || typeof raw.layout !== 'object' || Array.isArray(raw.layout))) invalid('layout must be an object', { stepId: raw.id });
      const layout = { ...(raw.layout || {}) };
      if (layout.reactantPlacement !== undefined && !['auto', 'horizontal', 'vertical'].includes(layout.reactantPlacement)) invalid('Unknown reactantPlacement', { stepId: raw.id });
      if (layout.breakBefore !== undefined && typeof layout.breakBefore !== 'boolean') invalid('breakBefore must be boolean', { stepId: raw.id });
      if (layout.conditions !== undefined && (typeof layout.conditions !== 'string' || layout.conditions.length > 200)) invalid('Invalid conditions', { stepId: raw.id });
      steps.set(raw.id, { id: raw.id, reactants: raw.reactants.slice(), products: raw.products.slice(), layout });
    }
    const obstacles = (input.obstacles || []).map((b, i) => {
      if (!b || !['x1', 'x2', 'y1', 'y2'].every(k => finite(b[k])) || b.x2 < b.x1 || b.y2 < b.y1) invalid('Invalid obstacle', { obstacleIndex: i });
      return { x1: b.x1, x2: b.x2, y1: b.y1, y2: b.y2 };
    });
    const groups = [], membership = new Set(), groupIds = new Set();
    for (const g of input.groups || []) {
      if (!g || typeof g.id !== 'string' || !g.id || groupIds.has(g.id) || !Array.isArray(g.moleculeIds) || !g.moleculeIds.length ||
          unique(g.moleculeIds).length !== g.moleculeIds.length || !g.moleculeIds.includes(g.mainId) || !Array.isArray(g.offsets)) {
        invalid('Invalid rigid group', { groupId: g?.id });
      }
      const offsets = new Map(g.offsets.map(p => [p.id, p]));
      if (offsets.size !== g.moleculeIds.length || g.moleculeIds.some(id => !molecules.has(id) || membership.has(id) || !point(offsets.get(id))) ||
          Math.abs(offsets.get(g.mainId).x) > 1e-8 || Math.abs(offsets.get(g.mainId).y) > 1e-8) {
        reject('reaction_graph_group_conflict', 'Rigid groups need unique members and offsets relative to their main molecule', { groupId: g.id, moleculeIds: g.moleculeIds.slice() });
      }
      groupIds.add(g.id); g.moleculeIds.forEach(id => membership.add(id));
      if (g.coLocate !== undefined && typeof g.coLocate !== 'boolean') invalid('Invalid coLocate', { groupId: g.id });
      if (g.coLocate && [...steps.values()].some(step => step.reactants.some(id => g.moleculeIds.includes(id)) && step.products.some(id => g.moleculeIds.includes(id)))) {
        reject('reaction_graph_group_conflict', 'A local reaction group cannot collapse successive chemical stages', { groupId: g.id });
      }
      groups.push({ id: g.id, mainId: g.mainId, coLocate: g.coLocate === true, moleculeIds: g.moleculeIds.slice(), offsets: new Map(g.moleculeIds.map(id => [id, { x: offsets.get(id).x, y: offsets.get(id).y }])) });
    }
    return { molecules, steps, options, anchor: { ...anchor }, rowWidth, maxRowWidth, obstacles, groups };
  }

  function graph(data) {
    const ids = sorted([...data.steps.keys()]), producers = new Map(), consumers = new Map();
    const next = new Map(ids.map(id => [id, new Set()])), previous = new Map(ids.map(id => [id, new Set()]));
    const neighbors = new Map(ids.map(id => [id, new Set()]));
    for (const id of ids) for (const [side, index] of [['products', producers], ['reactants', consumers]]) {
      for (const molecule of data.steps.get(id)[side]) {
        if (!index.has(molecule)) index.set(molecule, []);
        index.get(molecule).push(id);
      }
    }
    const connectWeak = xs => { for (const a of xs) for (const b of xs) if (a !== b) neighbors.get(a).add(b); };
    for (const molecule of data.molecules.keys()) {
      const from = producers.get(molecule) || [], to = consumers.get(molecule) || [];
      connectWeak(unique([...from, ...to]));
      for (const a of from) for (const b of to) { next.get(a).add(b); previous.get(b).add(a); }
    }
    for (const g of data.groups) connectWeak(unique(g.moleculeIds.flatMap(id => [...(producers.get(id) || []), ...(consumers.get(id) || [])])));
    const degree = new Map(ids.map(id => [id, previous.get(id).size])), pending = ids.filter(id => !degree.get(id)), order = [];
    while (pending.length) {
      pending.sort(lexical); const id = pending.shift(); order.push(id);
      for (const successor of next.get(id)) { degree.set(successor, degree.get(successor) - 1); if (!degree.get(successor)) pending.push(successor); }
    }
    if (order.length !== ids.length) reject('reaction_graph_cycle', 'Cyclic reaction references require a separate physical instance of the regenerated molecule', { stepIds: ids.filter(id => degree.get(id)) });
    const seen = new Set(), components = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const todo = [id], members = []; seen.add(id);
      while (todo.length) { const item = todo.pop(); members.push(item); for (const n of neighbors.get(item)) if (!seen.has(n)) { seen.add(n); todo.push(n); } }
      components.push(sorted(members));
    }
    return { producers, consumers, next, previous, order, components };
  }

  function isPreparationLink(from, to, weightOf) {
    const products = new Set(from.products);
    if (!to.reactants.some(id => products.has(id))) return false;
    const partners = to.reactants.filter(id => !products.has(id));
    if (!partners.length) return false;
    const preparationWeight = Math.max(...[...from.reactants, ...from.products].map(weightOf));
    return Math.max(...partners.map(weightOf)) >= 1.6 * preparationWeight;
  }

  // Keep small reagent preparation in its own display lane. The chemical DAG
  // remains intact: its one real product lives at the main consumer and paired
  // ports identify that product from the preparation lane.
  // Keep the best skeleton-bearing path for every possible length. The primary
  // path is longest, except a path one step shorter can win when its mean main
  // molecule weight is at least 1.6 times greater (small reagent preparation).
  function choosePath(remaining, g, data) {
    const choices = new Map();
    const follows = (from, to) => !isPreparationLink(data.steps.get(from), data.steps.get(to), id => data.molecules.get(id).weight);
    const stepWeight = id => Math.max(...[...data.steps.get(id).reactants, ...data.steps.get(id).products].map(m => data.molecules.get(m).weight));
    const better = (a, b) => !b || a.weight > b.weight || (a.weight === b.weight && lexical(a.ids.join('\0'), b.ids.join('\0')) < 0);
    for (const id of g.order.slice().reverse()) {
      if (!remaining.has(id)) continue;
      const map = new Map([[1, { ids: [id], weight: stepWeight(id) }]]);
      for (const n of sorted([...g.next.get(id)])) {
        if (!remaining.has(n) || !follows(id, n)) continue;
        for (const [length, tail] of choices.get(n)) {
          const value = { ids: [id, ...tail.ids], weight: stepWeight(id) + tail.weight };
          if (better(value, map.get(length + 1))) map.set(length + 1, value);
        }
      }
      choices.set(id, map);
    }
    const roots = sorted([...remaining].filter(id => ![...g.previous.get(id)].some(p => remaining.has(p) && follows(p, id))));
    const all = roots.flatMap(id => [...choices.get(id).values()]);
    const longest = Math.max(...all.map(p => p.ids.length));
    const byWeight = (a, b) => b.weight / b.ids.length - a.weight / a.ids.length || lexical(a.ids.join('\0'), b.ids.join('\0'));
    const bestLong = all.filter(p => p.ids.length === longest).sort(byWeight)[0];
    const near = all.filter(p => p.ids.length === longest - 1).sort(byWeight)[0];
    return near && near.weight / near.ids.length >= 1.6 * bestLong.weight / bestLong.ids.length ? near.ids : bestLong.ids;
  }

  function makeStages(data, g) {
    const routes = [], paths = [], stages = [], byStep = new Map();
    for (let r = 0; r < g.components.length; r++) {
      const route = { id: 'route-' + (r + 1), stepIds: [], laneIds: [] }, remaining = new Set(g.components[r]);
      routes.push(route);
      while (remaining.size) {
        const ids = choosePath(remaining, g, data), path = { id: route.id + '-path-' + (route.laneIds.length + 1), route, ids, stages: [], rank: paths.length };
        route.laneIds.push(path.id); route.stepIds.push(...ids); paths.push(path);
        for (let i = 0; i <= ids.length; i++) {
          const uses = [];
          if (i) uses.push({ stepId: ids[i - 1], side: 'products', moleculeIds: data.steps.get(ids[i - 1]).products });
          if (i < ids.length) uses.push({ stepId: ids[i], side: 'reactants', moleculeIds: data.steps.get(ids[i]).reactants });
          const stage = { id: path.id + '-stage-' + i, path, index: i, uses, real: [], proxies: [], required: unique(uses.flatMap(u => u.moleculeIds)) };
          path.stages.push(stage); stages.push(stage);
          if (i < ids.length) byStep.set(ids[i], { path, index: i });
        }
        ids.forEach(id => remaining.delete(id));
      }
    }
    const homes = new Map();
    const priority = (a, b) => byStep.get(a).path.rank - byStep.get(b).path.rank || byStep.get(a).index - byStep.get(b).index || lexical(a, b);
    for (const id of sorted([...data.molecules.keys()])) {
      const producer = (g.producers.get(id) || []).slice().sort(priority)[0];
      const consumer = (g.consumers.get(id) || []).slice().sort(priority)[0];
      // Prepared reagents belong beside the main consumer's real reactants.
      // Their preparation lane ends in a labelled output port; otherwise an
      // electron-flow arrow would still span from the remote preparation lane.
      const consumerHome = producer && consumer && byStep.get(producer).path.rank > byStep.get(consumer).path.rank;
      const owner = consumerHome ? consumer : producer || consumer;
      if (owner) { const at = byStep.get(owner); homes.set(id, at.path.stages[at.index + (producer && !consumerHome ? 1 : 0)]); }
    }
    // Unreferenced graph objects still receive one deterministic home.
    const unused = sorted([...data.molecules.keys()].filter(id => !homes.has(id)));
    if (unused.length) {
      const route = { id: 'route-isolated', stepIds: [], laneIds: ['route-isolated-path-1'] };
      const path = { id: route.laneIds[0], route, ids: [], stages: [], rank: paths.length };
      routes.push(route); paths.push(path);
      for (let i = 0; i < unused.length; i++) {
        const stage = { id: path.id + '-stage-' + i, path, index: i, uses: [], real: [], proxies: [], required: [unused[i]] };
        path.stages.push(stage); stages.push(stage); homes.set(unused[i], stage);
      }
    }
    for (const group of data.groups) {
      const home = homes.get(group.mainId), members = group.moleculeIds.map(id => homes.get(id));
      if (members.some(member => member !== home)) {
        if (group.coLocate || members.every(member => !member.uses.length)) group.moleculeIds.forEach(id => homes.set(id, home));
        else reject('reaction_graph_group_conflict', 'Rigid group members belong to different reaction stages',
          { groupId: group.id, moleculeIds: group.moleculeIds.slice(), stepIds: unique(members.flatMap(member => member.uses.map(use => use.stepId))) });
      }
    }
    for (const [id, home] of homes) home.real.push(id);
    for (const stage of stages) {
      const foreign = new Map();
      for (const id of stage.uses.length ? stage.required : []) {
        const home = homes.get(id);
        if (home === stage) continue;
        if (!foreign.has(home.id)) foreign.set(home.id, { id: stage.id + '-port-' + (foreign.size + 1), home, moleculeIds: [], uses: [] });
        const proxy = foreign.get(home.id); proxy.moleculeIds.push(id);
      }
      for (const proxy of foreign.values()) {
        proxy.uses = stage.uses.filter(use => use.moleculeIds.some(id => proxy.moleculeIds.includes(id))).map(use => ({ stepId: use.stepId, side: use.side }));
        stage.proxies.push(proxy);
      }
    }
    return { routes, paths, stages, homes, byStep };
  }

  function pack(stage, data) {
    const { options: o, molecules } = data;
    const owned = new Set(stage.real), units = [], grouped = new Set();
    for (const group of data.groups.slice().sort((a, b) => lexical(a.id, b.id))) {
      if (!group.moleculeIds.some(id => owned.has(id))) continue;
      if (!group.moleculeIds.every(id => owned.has(id))) reject('reaction_graph_group_conflict', 'Rigid group home assignment is inconsistent', { groupId: group.id, stepIds: stage.uses.map(u => u.stepId) });
      const bounds = union(group.moleculeIds.map(id => rect(group.offsets.get(id), molecules.get(id).width, molecules.get(id).height)));
      units.push({ id: group.id, mainId: group.mainId, ids: group.moleculeIds, offsets: group.offsets, bounds, weight: molecules.get(group.mainId).weight });
      group.moleculeIds.forEach(id => grouped.add(id));
    }
    const realOrder = unique([...stage.required, ...sorted(stage.real)]).filter(id => owned.has(id) && !grouped.has(id));
    for (const id of realOrder) {
      const m = molecules.get(id);
      units.push({ id, mainId: id, ids: [id], offsets: new Map([[id, { x: 0, y: 0 }]]), bounds: rect({ x: 0, y: 0 }, m.width, m.height), weight: m.weight });
    }
    let mainUnit = units.slice().sort((a, b) => b.weight - a.weight || lexical(a.mainId, b.mainId))[0];
    const use = stage.uses.find(u => u.side === 'reactants');
    const placement = use ? data.steps.get(use.stepId).layout.reactantPlacement : 'auto';
    const axis = placement === 'vertical' ? 'y' : 'x', other = axis === 'x' ? 'y' : 'x';
    const offsets = new Map(), proxyOffsets = new Map();
    let cursor = 0;
    const unitPositions = new Map();
    for (const u of units) {
      const length = u.bounds[axis + '2'] - u.bounds[axis + '1'];
      // A rigid group's main molecule defines its local baseline, not its bbox.
      const p = { x: 0, y: 0 }; p[axis] = cursor - u.bounds[axis + '1']; p[other] = 0;
      unitPositions.set(u, p); cursor += length + o.groupGap;
    }
    const mainPosition = mainUnit ? unitPositions.get(mainUnit) : { x: 0, y: 0 };
    for (const u of units) for (const id of u.ids) {
      const p = unitPositions.get(u), local = u.offsets.get(id);
      offsets.set(id, { x: p.x + local.x - mainPosition.x, y: p.y + local.y - mainPosition.y });
    }
    const realBounds = offsets.size ? union([...offsets].map(([id, p]) => rect(p, molecules.get(id).width, molecules.get(id).height))) : null;
    const proxyBoxes = [];
    for (let i = 0; i < stage.proxies.length; i++) {
      const p = { x: 0, y: realBounds ? realBounds.y2 + o.cueGap + o.cueLineHeight * (i + 0.5) : i * o.cueLineHeight };
      proxyOffsets.set(stage.proxies[i].id, p); proxyBoxes.push(rect(p, o.cueWidth, o.cueLineHeight));
    }
    const bounds = realBounds || proxyBoxes.length ? union([...(realBounds ? [realBounds] : []), ...proxyBoxes]) : rect({ x: 0, y: 0 }, o.cueWidth, o.cueLineHeight);
    // Horizontally centre the whole stage; retain main molecule y=0.
    const xCenter = middle(bounds).x;
    for (const p of offsets.values()) p.x -= xCenter;
    for (const p of proxyOffsets.values()) p.x -= xCenter;
    return { stage, offsets, proxyOffsets, mainId: mainUnit?.mainId || null,
      bounds: { x1: bounds.x1 - xCenter, x2: bounds.x2 - xCenter, y1: bounds.y1, y2: bounds.y2 },
      width: bounds.x2 - bounds.x1, height: bounds.y2 - bounds.y1 };
  }

  function compute(data) {
    const g = graph(data), state = makeStages(data, g), { options: o } = data;
    const packed = new Map(state.stages.map(stage => [stage.id, pack(stage, data)]));
    const positions = new Map(), stageLocations = new Map(), proxyLocations = new Map(), stepPlans = new Map();
    const rows = [], occupied = data.obstacles.slice(), cues = [], portsToLink = [];
    let nextTop = null, wrapNumber = o.tokenStart, bridgeNumber = o.tokenStart;
    const usageCount = new Map(state.stages.map(s => [s.id, 0]));
    for (const stage of state.stages) for (const proxy of stage.proxies) {
      usageCount.set(proxy.home.id, usageCount.get(proxy.home.id) + 1);
    }
    const allocateRow = (path, width, above, below, desiredY) => {
      let baseline = desiredY;
      for (;;) {
        const b = { x1: data.anchor.x, x2: data.anchor.x + width, y1: baseline - above, y2: baseline + below };
        const hit = occupied.filter(obstacle => overlap(b, obstacle, o.obstacleGap)).sort((a, b) => a.y2 - b.y2)[0];
        if (!hit) {
          occupied.push(b);
          const row = { id: path.id + '-row-' + (rows.filter(r => r.laneId === path.id).length + 1), laneId: path.id,
            routeId: path.route.id, stepIds: [], baseline, bounds: b, contentBottom: baseline + below - (path.annotationHeight || 0), annotationColumns: new Map() };
          rows.push(row); return row;
        }
        baseline = hit.y2 + o.obstacleGap + above + 1e-6;
      }
    };
    const placeStage = (p, at, row) => {
      stageLocations.set(p.stage.id, { at, row, packed: p });
      for (const [id, local] of p.offsets) {
        if (positions.has(id)) reject('reaction_graph_internal', 'A molecule was assigned more than one home', { moleculeId: id });
        positions.set(id, { id, x: at.x + local.x, y: at.y + local.y });
      }
      for (const [id, local] of p.proxyOffsets) proxyLocations.set(id, { x: at.x + local.x, y: at.y + local.y, row });
      return shiftBox(p.bounds, at);
    };
    const gapFor = step => Math.max(o.stepGap, o.minArrowLength + 2 * o.arrowPadding,
      step.layout.conditions ? textWidth(step.layout.conditions) + 0.7 : 0);
    const homeGroups = refs => {
      const grouped = new Map();
      for (const id of refs) {
        const home = state.homes.get(id);
        if (!grouped.has(home.id)) grouped.set(home.id, { home, moleculeIds: [] });
        grouped.get(home.id).moleculeIds.push(id);
      }
      return [...grouped.values()];
    };
    for (const path of state.paths) {
      const ps = path.stages.map(s => packed.get(s.id));
      const maxPorts = Math.max(1, ...path.ids.map(id => homeGroups(data.steps.get(id).reactants).length));
      const wrapHeight = maxPorts * o.cueLineHeight;
      // A home can receive its non-local reference labels plus one row-wrap
      // reference per input home. Reserve annotation space below content only.
      path.annotationHeight = o.cueGap + o.cueLineHeight * Math.max(1, ...path.stages.map(s => usageCount.get(s.id) + maxPorts));
      const above = Math.max(wrapHeight / 2, ...ps.map(p => -p.bounds.y1));
      const below = Math.max(wrapHeight / 2, ...ps.map(p => p.bounds.y2)) + path.annotationHeight;
      const requiredWidth = Math.max(...ps.map(p => p.width), ...path.ids.map((id, i) => o.cueWidth + gapFor(data.steps.get(id)) + ps[i + 1].width));
      const width = Math.max(data.rowWidth, requiredWidth);
      if (width > data.maxRowWidth + 1e-8) reject('reaction_graph_too_wide', 'A stage or its condition label exceeds the configured printable width',
        { laneId: path.id, stepIds: path.ids.slice(), requiredWidth: width, maxRowWidth: data.maxRowWidth });
      let row = allocateRow(path, width, above, below, nextTop === null ? data.anchor.y : nextTop + above), cursor = data.anchor.x;
      let currentBox = placeStage(ps[0], { x: cursor + ps[0].width / 2, y: row.baseline }, row);
      cursor = currentBox.x2;
      if (!path.ids.length) {
        for (let i = 1; i < ps.length; i++) {
          if (cursor + o.groupGap + ps[i].width > data.anchor.x + width) { row = allocateRow(path, width, above, below, row.bounds.y2 + o.rowGap + above); cursor = data.anchor.x - o.groupGap; }
          currentBox = placeStage(ps[i], { x: cursor + o.groupGap + ps[i].width / 2, y: row.baseline }, row); cursor = currentBox.x2;
        }
      }
      for (let i = 0; i < path.ids.length; i++) {
        const id = path.ids[i], step = data.steps.get(id), to = ps[i + 1], gap = gapFor(step);
        let wrapped = false, fromBox = currentBox, fromStage = path.stages[i];
        if (step.layout.breakBefore || row.stepIds.length >= o.rowSteps || cursor + gap + to.width > data.anchor.x + width + 1e-8) {
          wrapped = true; row = allocateRow(path, width, above, below, row.bounds.y2 + o.rowGap + above);
          fromBox = { x1: data.anchor.x, x2: data.anchor.x + o.cueWidth,
            y1: row.baseline - wrapHeight / 2, y2: row.baseline + wrapHeight / 2 };
          cursor = fromBox.x2;
          const refs = homeGroups(step.reactants);
          for (let n = 0; n < refs.length; n++) portsToLink.push({ ...refs[n], kind: 'wrap', useStage: fromStage,
            uses: [{ stepId: id, side: 'reactants' }], portId: id + '-wrap-' + n,
            at: { x: middle(fromBox).x, y: row.baseline + (n - (refs.length - 1) / 2) * o.cueLineHeight, row } });
        }
        const toBox = placeStage(to, { x: cursor + gap + to.width / 2, y: row.baseline }, row);
        const line = { start: { x: fromBox.x2 + o.arrowPadding, y: row.baseline }, end: { x: toBox.x1 - o.arrowPadding, y: row.baseline } };
        if (line.end.x - line.start.x < o.minArrowLength - 1e-8) reject('reaction_graph_no_arrow_lane', 'A step has no local horizontal arrow lane', { stepIds: [id] });
        row.stepIds.push(id);
        const flow = { reading: true, forward: true, axis: 'x', direction: 1,
          routeId: path.route.id, laneId: path.id, rowId: row.id, rowLeft: data.anchor.x,
          rowWidth: width, rowY: row.baseline, rowBottom: row.bounds.y2, rowRight: toBox.x2,
          steps: row.stepIds.length, graph: true, wrapped };
        stepPlans.set(id, { id, arrow: line, flow, ports: [], links: [] });
        currentBox = toBox; cursor = toBox.x2;
      }
      nextTop = Math.max(...rows.filter(r => r.laneId === path.id).map(r => r.bounds.y2)) +
        (state.paths[path.rank + 1]?.route !== path.route ? o.routeGap : o.rowGap);
    }
    // Non-local stage members already have a real home; this is only a label port.
    for (const stage of state.stages) for (const proxy of stage.proxies) {
      // A wrapped step reads its explicit new-row input ports, rather than the
      // old stage's copy of that reference label. Keep a shared output use.
      const uses = proxy.uses.filter(use => use.side !== 'reactants' || !stepPlans.get(use.stepId)?.flow.wrapped);
      if (!uses.length) continue;
      portsToLink.push({ ...proxy, uses, useStage: stage,
        kind: proxy.home.path === stage.path ? 'reuse' : uses.some(use => use.side === 'products') ? 'merge' : proxy.home.path.rank < stage.path.rank ? 'branch' : 'merge',
        portId: proxy.id, at: proxyLocations.get(proxy.id) });
    }
    // Horizontal wrapping is already fixed. Size each physical row from its
    // own stages and real reference ends, rather than giving every wrapped
    // row the tallest above/below extents found anywhere on the path.
    const rowContent = new Map(rows.map(row => [row, []]));
    for (const location of stageLocations.values()) {
      rowContent.get(location.row).push(shiftBox(location.packed.bounds,
        { x: location.at.x, y: location.at.y - location.row.baseline }));
    }
    const homeReferenceCounts = new Map();
    for (const link of portsToLink) {
      homeReferenceCounts.set(link.home.id, (homeReferenceCounts.get(link.home.id) || 0) + 1);
      const at = link.at;
      if (at?.row) rowContent.get(at.row).push(rect({ x: at.x, y: at.y - at.row.baseline }, o.cueWidth, o.cueLineHeight));
    }
    const rowReferenceCounts = new Map(rows.map(row => [row, 0]));
    for (const [stageId, count] of homeReferenceCounts) {
      const row = stageLocations.get(stageId).row;
      rowReferenceCounts.set(row, Math.max(rowReferenceCounts.get(row), count));
    }
    const compactOccupied = data.obstacles.slice(), rowShifts = new Map();
    let previousRow = null;
    for (const row of rows) {
      const boxes = rowContent.get(row);
      // Conditions sit above the local horizontal reaction arrow.
      const conditionAbove = row.stepIds.some(id => data.steps.get(id).layout.conditions) ? o.cueLineHeight + o.cueLineHeight / 2 : 0.15;
      const above = Math.max(conditionAbove, ...boxes.map(b => -b.y1));
      const contentBelow = Math.max(0.15, ...boxes.map(b => b.y2));
      const count = rowReferenceCounts.get(row);
      const below = contentBelow + (count ? o.cueGap + count * o.cueLineHeight : 0);
      let baseline = previousRow ? previousRow.bounds.y2 +
        (previousRow.routeId === row.routeId ? o.rowGap : o.routeGap) + above : data.anchor.y;
      let bounds;
      for (;;) {
        bounds = { x1: row.bounds.x1, x2: row.bounds.x2, y1: baseline - above, y2: baseline + below };
        const hit = compactOccupied.filter(obstacle => overlap(bounds, obstacle, o.obstacleGap)).sort((a, b) => a.y2 - b.y2)[0];
        if (!hit) break;
        baseline = hit.y2 + o.obstacleGap + above + 1e-6;
      }
      rowShifts.set(row, baseline - row.baseline);
      row.baseline = baseline; row.bounds = bounds; row.contentBottom = baseline + contentBelow;
      compactOccupied.push(bounds); previousRow = row;
    }
    const shifted = new Set();
    const shiftPoint = (p, row) => {
      if (!shifted.has(p)) { p.y += rowShifts.get(row); shifted.add(p); }
    };
    for (const location of stageLocations.values()) {
      shiftPoint(location.at, location.row);
      for (const id of location.packed.offsets.keys()) shiftPoint(positions.get(id), location.row);
    }
    for (const at of proxyLocations.values()) shiftPoint(at, at.row);
    for (const link of portsToLink) if (link.at?.row) shiftPoint(link.at, link.at.row);
    const rowsById = new Map(rows.map(row => [row.id, row]));
    for (const step of stepPlans.values()) {
      const row = rowsById.get(step.flow.rowId);
      shiftPoint(step.arrow.start, row); shiftPoint(step.arrow.end, row);
      step.flow.rowY = row.baseline; step.flow.rowBottom = row.bounds.y2;
    }
    const homeEnds = new Map(), allUses = state.stages.flatMap(stage => stage.uses);
    for (const link of portsToLink) {
      const homeLocation = stageLocations.get(link.home.id), moleculeBoxes = link.moleculeIds.map(id => {
        const p = positions.get(id), m = data.molecules.get(id); return rect(p, m.width, m.height);
      });
      const box = union(moleculeBoxes), index = homeEnds.get(link.home.id) || 0; homeEnds.set(link.home.id, index + 1);
      const findOwner = uses => uses.find(u => u.side === 'products' && u.moleculeIds.some(id => link.moleculeIds.includes(id))) ||
        uses.find(u => u.moleculeIds.some(id => link.moleculeIds.includes(id)));
      // Co-location can move a prepared reagent into a host stage that does
      // not itself use it. Keep the port owned by an actual chemical use while
      // its molecule end stays beside the reagent's physical home.
      const owner = findOwner(link.home.uses) || findOwner(allUses);
      const use = link.uses[0];
      if (!owner || !use || !link.at) reject('reaction_graph_group_conflict', 'A port has no corresponding graph step',
        { moleculeIds: link.moleculeIds, stepIds: link.uses.map(u => u.stepId) });
      const token = link.kind === 'wrap' ? '续 ' + (++wrapNumber) : '接 B' + (++bridgeNumber);
      const homeEnd = { stepId: owner.stepId, role: 'source', side: owner.side, at: 'molecule',
        x: middle(box).x, y: homeLocation.row.contentBottom + o.cueGap + (index + 0.5) * o.cueLineHeight };
      const portEnd = { stepId: use.stepId, role: 'target', side: use.side, at: 'port', x: link.at.x, y: link.at.y };
      const cue = { token, kind: link.kind, moleculeIds: sorted(link.moleculeIds), ends: [homeEnd, portEnd] };
      cues.push(cue);
      for (const [end, counterpart] of [[homeEnd, portEnd], [portEnd, homeEnd]]) {
        const plan = stepPlans.get(end.stepId);
        if (plan) plan.links.push({ cueToken: token, role: end.role, side: end.side, at: end.at, x: end.x, y: end.y, counterpartStepId: counterpart.stepId });
      }
      for (const useAt of link.uses) stepPlans.get(useAt.stepId)?.ports.push({ cueToken: token, side: useAt.side,
        moleculeIds: sorted(link.moleculeIds), x: link.at.x, y: link.at.y });
      if (link.kind === 'wrap') stepPlans.get(use.stepId).flow.continuation = token;
    }
    const placed = sorted([...positions.keys()]).map(id => positions.get(id));
    if (placed.length !== data.molecules.size) reject('reaction_graph_internal', 'Not every graph molecule received a home');
    const boxes = placed.map(p => rect(p, data.molecules.get(p.id).width, data.molecules.get(p.id).height));
    const labelBoxes = cues.flatMap(c => c.ends.map(end => rect(end, Math.max(o.cueWidth, textWidth(c.token)), o.cueLineHeight)));
    const allBounds = [...boxes, ...labelBoxes, ...[...stepPlans.values()].map(s => ({ x1: s.arrow.start.x, x2: s.arrow.end.x, y1: s.arrow.start.y - 0.15, y2: s.arrow.end.y + 0.15 }))];
    return { ok: true, positions: placed, steps: sorted([...stepPlans.keys()]).map(id => stepPlans.get(id)), cues,
      homes: sorted([...state.homes.keys()]).map(id => ({ moleculeId: id, stageId: state.homes.get(id).id })),
      routes: state.routes.map(route => ({ ...route })),
      lanes: rows.map(row => ({ id: row.id, laneId: row.laneId, routeId: row.routeId, stepIds: row.stepIds.slice(), bounds: { ...row.bounds }, baseline: row.baseline })),
      bounds: allBounds.length ? union(allBounds) : { x1: data.anchor.x, x2: data.anchor.x, y1: data.anchor.y, y2: data.anchor.y } };
  }
  function plan(input) {
    try { return compute(normalize(input)); }
    catch (error) {
      return { ok: false, diagnostic: error.diagnostic || { code: 'reaction_graph_internal', message: error.message || 'Reaction graph layout failed' } };
    }
  }
  const api = { plan, DEFAULTS, textWidth, isPreparationLink };
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  MW.reactionGraphLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
