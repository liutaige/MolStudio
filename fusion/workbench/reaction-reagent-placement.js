/* Translation-only local reagent docking. Host atoms and every bond vector,
 * stereobond direction and molecule orientation remain unchanged.
 *
 * plan({host:{id,x,y,width,height}, reagent:{id,x,y,width,height},
 *   contacts:[{host:{x,y},reagent:{x,y},weight?:1}], obstacles?:boxes,
 *   placement?:'auto'|'left'|'right'|'above'|'below'|'horizontal'|'vertical',
 *   gap?:0.35, minX?:minimumReagentLeftEdge, options?:{maxCandidates:24},
 *   evaluate?:(candidate)=>({feasible,labelHits,bondHits,arrowHits,
 *     length,arcRatio,maxBend,...diagnostics})})
 * -> {ok:true,position,translation,offset,hostPosition,group,feasible,
 *     metrics,score,candidates:[{position,translation,side,metrics,score}]}
 * -> {ok:false,diagnostic:{code,message}}
 *
 * contacts are absolute coordinates before the move. evaluate receives the
 * absolute candidate position, translation and translated contacts. The caller
 * should rebuild the actual atom-label/bond scene and route all affected arrows
 * there, rather than estimating the move from an empty routing scene.
 * obstacles exclude the moving reagent. No candidate moves the host.
 */
(function (root) {
  'use strict';
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const point = p => p && finite(p.x) && finite(p.y);
  const boxAt = (p, w, h) => ({ x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y - h / 2, y2: p.y + h / 2 });
  const overlap = (a, b, gap) => a.x1 < b.x2 + gap && a.x2 > b.x1 - gap && a.y1 < b.y2 + gap && a.y2 > b.y1 - gap;
  const failure = (code, message) => ({ ok: false, diagnostic: { code, message } });
  function plan(input) {
    if (!input || !input.host || !input.reagent) return failure('reaction_reagent_invalid_input', 'A fixed host and moving reagent are required');
    const { host, reagent } = input;
    for (const m of [host, reagent]) if (typeof m.id !== 'string' || !m.id || !point(m) || !finite(m.width) || m.width <= 0 || !finite(m.height) || m.height <= 0) {
      return failure('reaction_reagent_invalid_input', 'Molecules need stable IDs and finite positive bounds');
    }
    if (['siteWidth', 'siteHeight'].some(key => host[key] !== undefined && (!finite(host[key]) || host[key] <= 0))) {
      return failure('reaction_reagent_invalid_input', 'Reaction-site bounds must be finite and positive');
    }
    if (host.id === reagent.id || !Array.isArray(input.contacts) || !input.contacts.length ||
        input.contacts.some(c => !point(c.host) || !point(c.reagent) || (c.weight !== undefined && (!finite(c.weight) || c.weight <= 0)))) {
      return failure('reaction_reagent_invalid_input', 'Distinct molecules and real reacting contact coordinates are required');
    }
    const placement = input.placement || 'auto', gap = input.gap === undefined ? 0.35 : input.gap;
    const minX = input.minX === undefined ? -Infinity : input.minX;
    const maxCandidates = input.options?.maxCandidates === undefined ? 24 : input.options.maxCandidates;
    if (!['auto', 'left', 'right', 'above', 'below', 'horizontal', 'vertical'].includes(placement) || !finite(gap) || gap < 0 ||
        !(finite(minX) || minX === -Infinity) || !Number.isInteger(maxCandidates) || maxCandidates < 4 || maxCandidates > 200 ||
        (input.evaluate !== undefined && typeof input.evaluate !== 'function') || (input.obstacles !== undefined && !Array.isArray(input.obstacles))) {
      return failure('reaction_reagent_invalid_input', 'Invalid docking constraints');
    }
    const obstacles = input.obstacles || [];
    if (obstacles.some(b => !b || !['x1', 'x2', 'y1', 'y2'].every(k => finite(b[k])) || b.x2 < b.x1 || b.y2 < b.y1)) {
      return failure('reaction_reagent_invalid_input', 'Obstacles need finite bounds');
    }
    const hostBox = boxAt(host, host.width, host.height), originalBox = boxAt(reagent, reagent.width, reagent.height);
    const hardSide = ['left', 'right', 'above', 'below'].includes(placement) ? placement : null;
    const sides = hardSide ? [hardSide] : ['left', 'right', 'above', 'below'];
    const sideOf = b => b.x2 <= hostBox.x1 ? 'left' : b.x1 >= hostBox.x2 ? 'right' : b.y2 <= hostBox.y1 ? 'above' : b.y1 >= hostBox.y2 ? 'below' : 'overlap';
    const sideAllowed = b => !hardSide || sideOf(b) === hardSide;
    const weighted = fn => input.contacts.reduce((n, c) => n + fn(c) * (c.weight || 1), 0) /
      input.contacts.reduce((n, c) => n + (c.weight || 1), 0);
    const anchorHost = { x: weighted(c => c.host.x), y: weighted(c => c.host.y) };
    const reagentContactOffset = { x: weighted(c => c.reagent.x - reagent.x), y: weighted(c => c.reagent.y - reagent.y) };
    const normalizedSite = { x: (anchorHost.x - host.x) / ((host.siteWidth || host.width) / 2),
      y: (anchorHost.y - host.y) / ((host.siteHeight || host.height) / 2) };
    const siteSide = Math.abs(normalizedSite.x) >= 0.35 && Math.abs(normalizedSite.x) >= Math.abs(normalizedSite.y) * 0.9
      ? normalizedSite.x < 0 ? 'left' : 'right'
      : Math.abs(normalizedSite.y) >= 0.35 ? normalizedSite.y < 0 ? 'above' : 'below' : null;
    const candidates = [], keys = new Set();
    const add = (position, side, original = false) => {
      const bounds = boxAt(position, reagent.width, reagent.height);
      if (bounds.x1 < minX - 1e-8 || overlap(bounds, hostBox, Math.max(0, gap - 1e-7)) ||
          obstacles.some(b => overlap(bounds, b, 0.15)) || !sideAllowed(bounds)) return;
      const key = position.x.toFixed(7) + '/' + position.y.toFixed(7);
      if (keys.has(key)) return;
      keys.add(key);
      const translation = { dx: position.x - reagent.x, dy: position.y - reagent.y };
      const contacts = input.contacts.map(c => ({ host: { ...c.host }, reagent: { x: c.reagent.x + translation.dx, y: c.reagent.y + translation.dy }, weight: c.weight || 1 }));
      const distance = contacts.reduce((sum, c) => sum + Math.hypot(c.host.x - c.reagent.x, c.host.y - c.reagent.y) * c.weight, 0) /
        contacts.reduce((sum, c) => sum + c.weight, 0);
      const axisPenalty = placement === 'horizontal' && ['above', 'below'].includes(side) || placement === 'vertical' && ['left', 'right'].includes(side) ? 0.4 : 0;
      candidates.push({ position: { x: position.x, y: position.y }, translation, side, contacts, bounds, distance, axisPenalty, original });
    };
    if (!overlap(originalBox, hostBox, gap) && sideAllowed(originalBox)) add(reagent, sideOf(originalBox), true);
    for (const side of sides) for (const clearance of [gap, gap + 0.35, gap + 0.8]) for (const tangent of [0, -0.6, 0.6, -1.2, 1.2]) {
      const p = { x: anchorHost.x - reagentContactOffset.x, y: anchorHost.y - reagentContactOffset.y };
      if (side === 'left') p.x = hostBox.x1 - clearance - reagent.width / 2;
      if (side === 'right') p.x = hostBox.x2 + clearance + reagent.width / 2;
      if (side === 'above') p.y = hostBox.y1 - clearance - reagent.height / 2;
      if (side === 'below') p.y = hostBox.y2 + clearance + reagent.height / 2;
      if (side === 'left' || side === 'right') p.y += tangent; else p.x += tangent;
      // Move outward past fixed neighbors, rather than giving up or moving the host.
      for (let attempt = 0; attempt <= obstacles.length; attempt++) {
        const bounds = boxAt(p, reagent.width, reagent.height), hit = obstacles.find(b => overlap(bounds, b, 0.15));
        if (!hit) break;
        if (side === 'left') p.x = hit.x1 - 0.15 - reagent.width / 2 - 1e-6;
        if (side === 'right') p.x = hit.x2 + 0.15 + reagent.width / 2 + 1e-6;
        if (side === 'above') p.y = hit.y1 - 0.15 - reagent.height / 2 - 1e-6;
        if (side === 'below') p.y = hit.y2 + 0.15 + reagent.height / 2 + 1e-6;
      }
      add(p, side);
    }
    candidates.sort((a, b) => a.distance + a.axisPenalty - b.distance - b.axisPenalty || a.position.x - b.position.x || a.position.y - b.position.y);
    if (!candidates.length) return failure('reaction_reagent_blocked', 'No non-overlapping translation meets the requested side and existing canvas constraints');
    // Preserve directional coverage before filling the budget with close contacts.
    const selected = [];
    for (const side of sides) { const candidate = candidates.find(c => c.side === side); if (candidate && !selected.includes(candidate)) selected.push(candidate); }
    for (const candidate of candidates) if (!selected.includes(candidate) && selected.length < maxCandidates) selected.push(candidate);
    let evaluationErrors = 0;
    for (const candidate of selected) {
      let metrics;
      try { metrics = input.evaluate ? input.evaluate(candidate) : {}; }
      catch (error) { evaluationErrors++; metrics = { feasible: false, evaluationError: String(error?.message || error) }; }
      if (!metrics || typeof metrics !== 'object' || typeof metrics.then === 'function') return failure('reaction_reagent_invalid_evaluation', 'evaluate must synchronously return geometry metrics');
      const number = (key, fallback) => finite(metrics[key]) && metrics[key] >= 0 ? metrics[key] : fallback;
      const labelHits = number('labelHits', Array.isArray(metrics.collisions?.labels) ? metrics.collisions.labels.length : 0);
      const bondHits = number('bondHits', Array.isArray(metrics.collisions?.bonds) ? metrics.collisions.bonds.length : 0);
      const arrowHits = number('arrowHits', 0), length = number('length', candidate.distance), chord = number('chord', candidate.distance), arcRatio = number('arcRatio', 1), maxBend = Math.abs(finite(metrics.maxBend) ? metrics.maxBend : 0);
      const feasible = metrics.feasible !== false && labelHits === 0 && bondHits === 0;
      candidate.metrics = { ...metrics, feasible, labelHits, bondHits, arrowHits, length, chord, arcRatio, maxBend, contactDistance: candidate.distance };
      candidate.score = (feasible ? 0 : 100000) + labelHits * 10000 + bondHits * 5000 + arrowHits * 1000 +
        length * 1.5 + candidate.distance * 0.9 + Math.max(0, arcRatio - 1.2) * 18 + Math.max(0, maxBend - 0.75) * 3 + candidate.axisPenalty;
    }
    if (evaluationErrors === selected.length) return failure('reaction_reagent_evaluation_failed', 'No candidate could be evaluated against the real arrow scene');
    // A visible edge site prefers its outward side when an ordinary clear arc
    // exists there. It must not lose to a slightly shorter below-host placement.
    const preferOutward = placement === 'auto' && siteSide && selected.some(c => c.side === siteSide && c.metrics.feasible &&
      !c.metrics.arrowHits && c.metrics.arcRatio <= 2.5 && c.metrics.maxBend <= 2.5);
    if (preferOutward) for (const c of selected) if (c.side !== siteSide) c.score += 1000;
    selected.sort((a, b) => a.score - b.score || a.distance - b.distance || a.position.x - b.position.x || a.position.y - b.position.y);
    const best = selected[0], offset = { x: best.position.x - host.x, y: best.position.y - host.y };
    return { ok: true, position: best.position, translation: best.translation, offset, hostPosition: { x: host.x, y: host.y },
      group: { mainId: host.id, moleculeIds: [host.id, reagent.id], offsets: [{ id: host.id, x: 0, y: 0 }, { id: reagent.id, ...offset }] },
      feasible: best.metrics.feasible, metrics: best.metrics, score: best.score, preferredSide: placement === 'auto' ? siteSide : hardSide,
      candidates: selected.map(c => ({ position: c.position, translation: c.translation, side: c.side, score: c.score, metrics: c.metrics })) };
  }
  const api = { plan };
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  MW.reactionReagentPlacement = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
