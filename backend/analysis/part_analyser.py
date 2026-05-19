from analysis.assembly import parse_assembly, _is_purchase_part
from analysis.bends import analyse_bends
from analysis.blank import analyse_blank, estimate_cut_perimeter
from analysis.features import analyse_step_features, analyse_step_features_text, classify_component
from analysis.holes import analyse_holes
from analysis.welding import analyse_welding


def analyse_part(path: str) -> dict:
    with open(path, "r", errors="replace") as fh:
        text = fh.read()

    assembly = parse_assembly(text)

    raw = analyse_step_features_text(text)
    holes = analyse_holes(raw)
    bends = analyse_bends(raw)
    welding = analyse_welding(raw)

    result = {
        **raw,
        **holes,
        **bends,
        "welding": welding,
    }

    try:
        blank = analyse_blank(path, k_factor=0.33)
        result["flat_blank_w_mm"] = blank["flat_blank_w_mm"]
        result["flat_blank_h_mm"] = blank["flat_blank_h_mm"]
        result["flat_pattern_area_mm2"] = blank["flat_pattern_area_mm2"]
        result["cut_perimeter_mm"] = estimate_cut_perimeter(
            blank["flat_blank_w_mm"],
            blank["flat_blank_h_mm"],
            holes["holes_mm"],
        )
    except Exception:
        pass

    geom_type = classify_component(raw)
    for comp in assembly["components"]:
        if comp["is_assembly"]:
            comp["type"] = "assembly"
        elif _is_purchase_part(comp["part_number"]):
            comp["type"] = "purchase"
        else:
            comp["type"] = geom_type

    result["is_assembly"] = assembly["is_assembly"]
    result["component_count"] = assembly["component_count"]
    result["components"] = assembly["components"]

    return result

