import re
from typing import Dict, List, Optional, Tuple

_PURCHASE_KEYWORDS = {
    'STUD', 'BOLT', 'NUT', 'SCREW', 'RIVET', 'WASHER', 'PIN',
    'FASTENER', 'BUSH', 'BUSHING', 'BEARING', 'SPRING', 'CLIP',
    'CIRCLIP', 'SEAL', 'GASKET', 'INSERT', 'STANDOFF',
}


def _is_purchase_part(name: str) -> bool:
    upper = name.upper()
    return any(kw in upper for kw in _PURCHASE_KEYWORDS)


def _parse_products(text: str) -> Dict[str, dict]:
    products = {}
    for m in re.finditer(
        r"#(\d+)\s*=\s*PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'",
        text, re.IGNORECASE,
    ):
        eid, pid, name, desc = m.group(1), m.group(2), m.group(3), m.group(4)
        products[eid] = {"part_id": pid, "name": name, "description": desc}
    return products


def _parse_pdf(text: str) -> Dict[str, str]:
    """PRODUCT_DEFINITION_FORMATION #id -> PRODUCT #id"""
    pdf_to_product: Dict[str, str] = {}
    for m in re.finditer(
        r"#(\d+)\s*=\s*PRODUCT_DEFINITION_FORMATION[^(]*\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*#(\d+)",
        text, re.IGNORECASE,
    ):
        pdf_to_product[m.group(1)] = m.group(2)
    return pdf_to_product


def _parse_pd(text: str) -> Dict[str, str]:
    """PRODUCT_DEFINITION #id -> PRODUCT_DEFINITION_FORMATION #id"""
    pd_to_pdf: Dict[str, str] = {}
    for m in re.finditer(
        r"#(\d+)\s*=\s*PRODUCT_DEFINITION\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*#(\d+)",
        text, re.IGNORECASE,
    ):
        pd_to_pdf[m.group(1)] = m.group(2)
    return pd_to_pdf


def _parse_nauo(text: str) -> List[Tuple[str, str]]:
    """Return (parent_pd_id, child_pd_id) pairs from NEXT_ASSEMBLY_USAGE_OCCUR(R)ENCE."""
    edges: List[Tuple[str, str]] = []
    for m in re.finditer(
        r"NEXT_ASSEMBLY_USAGE_OCCUR(?:R?ENCE)\s*\([^,]*,[^,]*,[^,]*,\s*#(\d+)\s*,\s*#(\d+)",
        text, re.IGNORECASE | re.DOTALL,
    ):
        edges.append((m.group(1), m.group(2)))
    return edges


def parse_assembly(text: str) -> dict:
    """
    Parse STEP product tree from raw text.

    Returns:
        {
            "is_assembly": bool,
            "component_count": int,
            "components": [
                {
                    "part_number": str,
                    "description": str,
                    "level": int,
                    "is_assembly": bool,
                },
                ...
            ]
        }
    """
    products = _parse_products(text)
    pdf_to_product = _parse_pdf(text)
    pd_to_pdf = _parse_pd(text)
    nauo_edges = _parse_nauo(text)

    def _resolve(pd_id: str) -> Optional[dict]:
        pdf_id = pd_to_pdf.get(pd_id)
        if pdf_id is None:
            return None
        prod_id = pdf_to_product.get(pdf_id)
        if prod_id is None:
            return None
        return products.get(prod_id)

    if not nauo_edges:
        if products:
            first = next(iter(products.values()))
            return {
                "is_assembly": False,
                "component_count": 1,
                "components": [{
                    "part_number": first["part_id"] or first["name"],
                    "description": first["description"],
                    "level": 0,
                    "is_assembly": False,
                }],
            }
        return {"is_assembly": False, "component_count": 0, "components": []}

    parent_pds = {e[0] for e in nauo_edges}
    child_pds = {e[1] for e in nauo_edges}
    root_pds = parent_pds - child_pds

    children_of: Dict[str, List[str]] = {}
    for parent, child in nauo_edges:
        children_of.setdefault(parent, []).append(child)

    components: List[dict] = []

    def _walk(pd_id: str, level: int, visited: set) -> None:
        if pd_id in visited:
            return
        visited.add(pd_id)
        info = _resolve(pd_id) or {"part_id": "", "name": f"PD#{pd_id}", "description": ""}
        kids = children_of.get(pd_id, [])
        components.append({
            "part_number": info["part_id"] or info["name"],
            "description": info["description"],
            "level": level,
            "is_assembly": len(kids) > 0,
        })
        for child_pd in kids:
            _walk(child_pd, level + 1, visited)

    for root in sorted(root_pds):
        _walk(root, 0, set())

    return {
        "is_assembly": True,
        "component_count": len(components),
        "components": components,
    }
