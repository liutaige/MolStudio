"""Model-facing views of external MCP results, without changing canvas state.

Compact results keep editable identities, chemical properties and diagnostics.
Only known redundant observations and rendering internals are removed. Callers
requesting exact rendering data can bypass these views with ``detail: full``.
"""
from __future__ import annotations

from copy import deepcopy


def _records(value):
    return value if isinstance(value, list) else []


def _compact_atom(atom, bonds):
    if not isinstance(atom, dict):
        return deepcopy(atom)
    out = deepcopy(atom)
    # All bond connectivity remains in bonds[]. Do not discard an unfamiliar or
    # unresolved neighbor record: it may carry information absent from that table.
    neighbors = atom.get("neighbors")
    if isinstance(atom.get("id"), str) and isinstance(neighbors, list) and all(
        isinstance(item, dict)
        and not (set(item) - {"uuid", "order", "aromatic", "angle"})
        and isinstance(item.get("uuid"), str)
        and isinstance(item.get("order"), (int, float))
        and (atom.get("id"), item.get("uuid"), item.get("order")) in bonds
        for item in neighbors
    ):
        out.pop("neighbors", None)
    for name in ("stereoLabel", "stereoParity", "alias"):
        if out.get(name) is None:
            out.pop(name, None)
    return out


def _compact_canvas(value):
    out = deepcopy(value)
    bond_edges = set()
    for bond in _records(value.get("bonds")):
        if isinstance(bond, dict):
            begin, end, order = bond.get("begin"), bond.get("end"), bond.get("order")
            if isinstance(begin, str) and isinstance(end, str) and isinstance(order, (int, float)):
                bond_edges.add((begin, end, order))
                bond_edges.add((end, begin, order))
    if isinstance(value.get("atoms"), list):
        out["atoms"] = [_compact_atom(atom, bond_edges) for atom in value["atoms"]]
    for arrow in _records(out.get("arrows")):
        if not isinstance(arrow, dict):
            continue
        geometry = arrow.get("geometry")
        if isinstance(geometry, dict):
            geometry.pop("routeVersion", None)
            geometry.pop("controlFrame", None)
        if arrow.get("pairId") is None:
            arrow.pop("pairId", None)
    # reactionSteps is the authoritative versioned semantic observation. Keep
    # the native arrow identity and geometry, without a second copy of its sides.
    steps = {step.get("reactionArrowId"): step for step in _records(value.get("reactionSteps"))
             if isinstance(step, dict) and isinstance(step.get("reactionArrowId"), str)}
    for arrow in _records(out.get("reactionArrows")):
        if not isinstance(arrow, dict):
            continue
        step = steps.get(str(arrow.get("id")))
        if step:
            for key in ("reactants", "products", "conditions", "version"):
                if key in arrow and arrow[key] == step.get(key):
                    arrow.pop(key)
    return out


def _compact_receipt(value):
    out = deepcopy(value)
    receipts = {step.get("operationId"): step for step in _records(value.get("steps"))
                if isinstance(step, dict) and isinstance(step.get("operationId"), str)}
    for name in ("created", "updated", "deleted", "cascaded"):
        for entry in _records(out.get(name)):
            if not isinstance(entry, dict):
                continue
            receipt = receipts.get(entry.get("id"))
            if receipt:
                # A semantic edit is reported both as an entity change and in
                # steps[]. Keep its before/after observation in one place.
                for key in ("before", "after"):
                    if key in entry and entry[key] == receipt.get(key):
                        entry.pop(key)
    for step in _records(out.get("steps")):
        if not isinstance(step, dict):
            continue
        after = step.get("after")
        if isinstance(after, dict):
            if "checks" in after and after["checks"] == step.get("checks"):
                after.pop("checks")
            if "layoutStatus" in after and after["layoutStatus"] == step.get("layout"):
                after.pop("layoutStatus")
    return out


def _compact_inspection(value):
    out = deepcopy(value)
    for item in out:
        if not isinstance(item, dict) or item.get("ok") is not True:
            continue
        for key in ("atoms", "bonds"):
            for entry in _records(item.get(key)):
                # ref is the public reference. The zero-based parser index is
                # redundant only when that explicit reference is present.
                if isinstance(entry, dict) and isinstance(entry.get("ref"), str):
                    entry.pop("index", None)
    return out


def compact_response(tool_name, value):
    """Return a detached, compact view of a parsed tool result.

    Nonmatching/unknown shapes and all unrecognized fields are preserved. This
    intentionally does not truncate lists, warnings, failed inspections, step
    checks, completion failures or repair diagnostics.
    """
    name = tool_name.removeprefix("molstudio_")
    if name == "read_canvas" and isinstance(value, dict):
        return _compact_canvas(value)
    if name == "draw_operations" and isinstance(value, dict):
        return _compact_receipt(value)
    if name == "inspect_structures" and isinstance(value, list):
        return _compact_inspection(value)
    return deepcopy(value)


def select_canvas_steps(value, step_ids):
    """Read selected steps with complete participating molecular components.

    Electron flows touching the selected reactant components are retained along
    with the structures needed to resolve both endpoints. Continuation text and
    mechanism group metadata stay available; the scope reports global and
    returned counts so a partial read cannot be mistaken for the entire canvas.
    """
    if not isinstance(value, dict):
        raise ValueError("按步骤读取需要有效的画布对象")
    if not isinstance(step_ids, list) or not step_ids or any(not isinstance(s, str) or not s for s in step_ids):
        raise ValueError("stepIds 必须是非空的步骤 ID 列表")
    if len(set(step_ids)) != len(step_ids):
        raise ValueError("stepIds 不能包含重复步骤 ID")
    steps = {step.get("stepId"): step for step in _records(value.get("reactionSteps")) if isinstance(step, dict)}
    missing = [step_id for step_id in step_ids if step_id not in steps]
    if missing:
        raise ValueError("未找到反应步骤：" + ", ".join(missing))
    selected_steps = [steps[step_id] for step_id in step_ids]
    atoms = {atom.get("id"): atom for atom in _records(value.get("atoms")) if isinstance(atom, dict)}
    bonds = {bond.get("id"): bond for bond in _records(value.get("bonds")) if isinstance(bond, dict)}
    pairs = {pair.get("id"): pair for pair in _records(value.get("lonePairs")) if isinstance(pair, dict)}
    adjacency = {atom_id: set() for atom_id in atoms}
    for bond in bonds.values():
        begin, end = bond.get("begin"), bond.get("end")
        if begin in adjacency and end in adjacency:
            adjacency[begin].add(end)
            adjacency[end].add(begin)
    # Molecule memberships are retained verbatim because mol:N handles are
    # validated against these complete current components when editing.
    for molecule in _records(value.get("molecules")):
        if not isinstance(molecule, dict):
            continue
        members = [atom_id for atom_id in _records(molecule.get("atoms")) if atom_id in atoms]
        if members:
            for atom_id in members[1:]:
                adjacency[members[0]].add(atom_id)
                adjacency[atom_id].add(members[0])

    def closure(refs):
        seen, pending = set(), list(refs)
        while pending:
            atom_id = pending.pop()
            if atom_id not in atoms or atom_id in seen:
                continue
            seen.add(atom_id)
            pending.extend(adjacency[atom_id] - seen)
        return seen

    reactant_refs = [ref for step in selected_steps for ref in _records(step.get("reactants"))]
    participant_refs = reactant_refs + [ref for step in selected_steps for ref in _records(step.get("products"))]
    # Graph ports can point back to a shared intermediate displayed elsewhere.
    # Keep those component identities with the selected continuation observation.
    participant_refs += [ref for step in selected_steps for port in _records(step.get("ports"))
                         if isinstance(port, dict) for ref in _records(port.get("anchorRefs"))]
    unresolved = [ref for ref in participant_refs if ref not in atoms]
    if unresolved:
        raise ValueError("步骤引用的原子不在当前画布中：" + ", ".join(str(ref) for ref in unresolved))
    reactant_atoms = closure(reactant_refs)
    selected_atoms = closure(participant_refs)

    def endpoint_atoms(endpoint):
        if not isinstance(endpoint, dict):
            return set()
        kind = endpoint.get("type")
        if kind == "atom":
            return {endpoint.get("atomId")} - {None}
        if kind == "radical":
            return {endpoint.get("ownerAtomId")} - {None}
        if kind == "formingBond":
            return {endpoint.get("atomA", endpoint.get("atom1")), endpoint.get("atomB", endpoint.get("atom2"))} - {None}
        if kind == "bond":
            bond = bonds.get(endpoint.get("bondId"))
            if bond:
                return {bond.get("begin"), bond.get("end")} - {None}
            return {endpoint.get("atom1"), endpoint.get("atom2")} - {None}
        if kind == "lonePair":
            pair = pairs.get(endpoint.get("slotId", endpoint.get("id")), {})
            return {pair.get("ownerAtomId"), endpoint.get("ownerAtomId")} - {None}
        return set()

    selected_arrows = []
    for arrow in _records(value.get("arrows")):
        if not isinstance(arrow, dict):
            continue
        refs = endpoint_atoms(arrow.get("source")) | endpoint_atoms(arrow.get("target"))
        if refs & reactant_atoms or arrow.get("stepId") in step_ids:
            selected_arrows.append(arrow)
            selected_atoms.update(closure(refs))
    arrow_pair_ids = {arrow.get("source", {}).get("slotId", arrow.get("source", {}).get("id"))
                      for arrow in selected_arrows if isinstance(arrow.get("source"), dict)}
    selected_pairs = [pair for pair in pairs.values()
                      if pair.get("ownerAtomId") in selected_atoms or pair.get("id") in arrow_pair_ids]
    for pair in selected_pairs:
        # Automatic aim is defined relative to refAtomId, which can be an
        # attacked atom on a different component rather than a bonded neighbor.
        selected_atoms.update(closure([pair.get("ownerAtomId"), pair.get("refAtomId")]))
    selected_bonds = {bond_id for bond_id, bond in bonds.items()
                      if bond.get("begin") in selected_atoms and bond.get("end") in selected_atoms}
    native_ids = {str(step.get("reactionArrowId")) for step in selected_steps if step.get("reactionArrowId") is not None}
    out = deepcopy(value)
    out["atoms"] = [deepcopy(atom) for atom in _records(value.get("atoms")) if isinstance(atom, dict) and atom.get("id") in selected_atoms]
    out["bonds"] = [deepcopy(bond) for bond in _records(value.get("bonds")) if isinstance(bond, dict) and bond.get("id") in selected_bonds]
    out["molecules"] = [deepcopy(molecule) for molecule in _records(value.get("molecules"))
                        if isinstance(molecule, dict) and any(atom in selected_atoms for atom in _records(molecule.get("atoms")))]
    out["lonePairs"] = deepcopy(selected_pairs)
    out["arrows"] = deepcopy(selected_arrows)
    out["reactionSteps"] = deepcopy(selected_steps)
    out["reactionArrows"] = [deepcopy(arrow) for arrow in _records(value.get("reactionArrows"))
                             if isinstance(arrow, dict) and str(arrow.get("id")) in native_ids]
    selection = out.get("selection")
    if isinstance(selection, dict):
        mechanism_ids = {item.get("id") for item in selected_arrows + selected_pairs}
        for field, allowed in (("atoms", selected_atoms), ("bonds", selected_bonds), ("mechanism", mechanism_ids)):
            if isinstance(selection.get(field), list):
                selection[field] = [item for item in selection[field] if item in allowed]
    counted = ("atoms", "bonds", "molecules", "lonePairs", "arrows", "reactionSteps", "reactionArrows")
    out["scope"] = {"stepIds": list(step_ids),
                    "total": {key: len(_records(value.get(key))) for key in counted},
                    "returned": {key: len(_records(out.get(key))) for key in counted}}
    return out
