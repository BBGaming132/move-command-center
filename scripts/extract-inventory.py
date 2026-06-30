#!/usr/bin/env python3
"""Extract the verified household-goods table from the JK inventory PDF.

Usage:
  python scripts/extract-inventory.py /path/to/Inventory_Summary_....pdf

The PDF table splits six records across page boundaries. Those known splits are
rejoined explicitly and then validated against the printed total of 388 pieces.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber

EXPECTED_ITEMS = 388
EXPECTED_PHYSICAL_CRATES = 14
ORIGINAL_STORAGE_PALLETS = 18
INVENTORY_PAGE_START = 4
INVENTORY_PAGE_END = 20

BOUNDARY_PATCHES = {
    60: {"packer": "ALVAREZ-ANDRADE-JULISSA", "pack_type": "4.5 Carton", "room": "Basement"},
    85: {"packer": "ALVAREZ-ANDRADE-JULISSA", "pack_type": "4.5 Carton", "room": "Green Room"},
    149: {"packer": "GODOY-SANDRA", "pack_type": "4.5 Carton", "room": "Family Room"},
    310: {"packer": "HALL-CHEVAR", "pack_type": "Blanket Wrap", "room": "Family Room"},
    339: {"packer": "HALL-CHEVAR", "pack_type": "Blanket Wrap", "room": "Dining Room"},
    366: {"packer": "HALL-CHEVAR", "pack_type": "Blanket Wrap", "room": "Garage"},
}

CONDITION_CODES = {
    "HV": "High value",
    "DBO": "Disassembled by owner",
    "PBO": "Packed by owner",
    "MCU": "Mechanical condition unknown",
    "ECU": "Electronic condition unknown",
}


def clean(value: str | None) -> str:
    value = (value or "").replace("\u0000", " ").replace("\ufffe", " ")
    value = re.sub(r"\s*\n\s*", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def condition_codes(comments: str) -> list[str]:
    upper = comments.upper()
    return [code for code in CONDITION_CODES if re.search(rf"\b{re.escape(code)}\b", upper)]


def make_tags(row: dict) -> list[str]:
    item_id = row["inventory_id"]
    values = [
        str(item_id), f"{item_id:02d}", f"{item_id:03d}", f"item {item_id}",
        f"inventory {item_id}", f"piece {item_id}", row["content"], row["packer"],
        row["pack_type"], row["room"], row["comments"], *row["condition_codes"],
    ]
    if row["high_value"]:
        values += ["high value", "valuable", "hv"]
    tokens: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = re.sub(r"\s+", " ", str(value)).strip()
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            tokens.append(normalized)
    return tokens


def extract(pdf_path: Path) -> list[dict]:
    rows: list[dict] = []
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 27:
            raise ValueError(f"Expected 27 PDF pages, found {len(pdf.pages)}")
        for page_index in range(INVENTORY_PAGE_START - 1, INVENTORY_PAGE_END):
            page_number = page_index + 1
            page_rows = 0
            for table in pdf.pages[page_index].extract_tables():
                for table_row_index, cells in enumerate(table, start=1):
                    values = [clean(cell) for cell in cells]
                    id_index = next((i for i, value in enumerate(values) if re.fullmatch(r"\d{1,3}", value)), None)
                    if id_index is None:
                        continue
                    inventory_id = int(values[id_index])
                    if not 1 <= inventory_id <= EXPECTED_ITEMS:
                        continue
                    fields = values[id_index:id_index + 7]
                    fields += [""] * (7 - len(fields))
                    inventory_id_text, ld, content, packer, pack_type, room, comments = fields[:7]
                    row = {
                        "inventory_id": int(inventory_id_text),
                        "ld": ld,
                        "content": content,
                        "packer": packer,
                        "pack_type": pack_type,
                        "room": room,
                        "comments": comments,
                        "source_page": page_number,
                        "source_table_row": table_row_index,
                    }
                    rows.append(row)
                    page_rows += 1
            if page_rows == 0:
                raise ValueError(f"No inventory rows extracted from PDF page {page_number}")

    rows.sort(key=lambda row: row["inventory_id"])
    for row in rows:
        patch = BOUNDARY_PATCHES.get(row["inventory_id"])
        if patch:
            row.update(patch)
        row["condition_codes"] = condition_codes(row["comments"])
        row["high_value"] = "HV" in row["condition_codes"]

    ids = [row["inventory_id"] for row in rows]
    expected_ids = list(range(1, EXPECTED_ITEMS + 1))
    if ids != expected_ids:
        missing = sorted(set(expected_ids) - set(ids))
        duplicates = sorted(item for item, count in Counter(ids).items() if count > 1)
        raise ValueError(f"Inventory IDs failed continuity check. Missing={missing}; duplicates={duplicates}")

    allowed_rooms = {
        "Basement", "Brown Room", "Dining Room", "Family Room", "Foyer", "Garage",
        "Green Room", "Guest Room", "Kitchen", "Linen Closet", "Living Room",
        "Master Bath", "Master Bedroom", "Office", "Piano Room",
    }
    invalid_rooms = sorted({row["room"] for row in rows if row["room"] not in allowed_rooms})
    if invalid_rooms:
        raise ValueError(f"Unexpected room values after boundary repair: {invalid_rooms}")

    partial_packers = [row for row in rows if row["packer"] in {"CHEVAR", "HALL-", "JULISSA", "SANDRA", "ANDRADE-JULISSA"}]
    if partial_packers:
        raise ValueError(f"Unrepaired page-boundary packer fragments: {[r['inventory_id'] for r in partial_packers]}")

    return rows


def make_bundle(pdf_path: Path, rows: list[dict]) -> dict:
    generated = datetime.now(timezone.utc).isoformat()
    physical_crates = [
        {
            "crateId": f"CRATE-{number:02d}",
            "displayName": f"Incoming Crate {number}",
            "originalLabel": "",
            "sourcePages": [],
            "notes": "Current delivery crate. The pack-out PDF does not identify which inventory pieces are inside.",
            "isPhysical": True,
        }
        for number in range(1, EXPECTED_PHYSICAL_CRATES + 1)
    ]
    crates = [
        {
            "crateId": "UNASSIGNED",
            "displayName": "Crate Not Yet Known",
            "originalLabel": "No item-to-crate map in source PDF",
            "sourcePages": list(range(INVENTORY_PAGE_START, INVENTORY_PAGE_END + 1)),
            "notes": "All pieces start here until a current crate label or manifest is known.",
            "isPhysical": False,
        },
        *physical_crates,
    ]

    items = []
    for row in rows:
        details = row["comments"]
        description = row["content"] if not details else f"{row['content']} - {details}"
        raw_line = " | ".join([
            f"ID {row['inventory_id']}", row["ld"], row["content"], row["packer"],
            row["pack_type"], row["room"], row["comments"],
        ])
        items.append({
            "itemId": str(row["inventory_id"]),
            "crateId": "UNASSIGNED",
            "sequence": row["inventory_id"],
            "description": description,
            "originalRoom": row["room"],
            "originalCode": row["pack_type"],
            "quantity": 1,
            "rawLine": raw_line,
            "sourcePage": row["source_page"],
            "sourceRow": f"Household Goods Descriptive Inventory ID {row['inventory_id']}",
            "sourceFields": {
                "Inventory ID": row["inventory_id"],
                "LD": row["ld"],
                "Content": row["content"],
                "Packer": row["packer"],
                "Pack Type": row["pack_type"],
                "Original Room": row["room"],
                "Comments": row["comments"],
                "High Value": row["high_value"],
                "Condition Codes": ", ".join(row["condition_codes"]),
                "Source Document": pdf_path.name,
            },
            "tags": make_tags(row),
        })

    return {
        "metadata": {
            "title": "Parents Move Inventory",
            "version": "0.2.0-pdf-import",
            "generatedAt": generated,
            "status": "verified",
            "expectedCrateCount": EXPECTED_PHYSICAL_CRATES,
            "expectedItemCount": EXPECTED_ITEMS,
            "originalStoragePalletCount": ORIGINAL_STORAGE_PALLETS,
            "crateMappingStatus": "not-provided-in-source",
            "sourceDocuments": [{
                "fileName": pdf_path.name,
                "sha256": sha256(pdf_path),
                "pageCount": 27,
            }],
            "notes": (
                "Verified extraction of 388 inventory pieces. The 2024 pack-out paperwork reports 18 local-storage "
                "pallets, while the current delivery is expected to use 14 crates. The source PDF contains no "
                "piece-to-pallet or piece-to-current-crate mapping, so every item begins in UNASSIGNED."
            ),
        },
        "crates": crates,
        "items": items,
    }


def write_audit(root: Path, rows: list[dict], bundle: dict) -> None:
    audit_dir = root / "private-data" / "audit"
    audit_dir.mkdir(exist_ok=True)
    with (audit_dir / "inventory-audit.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "inventory_id", "source_page", "source_table_row", "content", "packer", "pack_type",
            "room", "comments", "high_value", "condition_codes",
        ])
        writer.writeheader()
        for row in rows:
            output = dict(row)
            output["condition_codes"] = ", ".join(row["condition_codes"])
            writer.writerow({key: output.get(key, "") for key in writer.fieldnames})

    summary = {
        "checks": {
            "continuousIds1Through388": True,
            "uniqueItemIds": True,
            "itemCount": len(rows),
            "inventoryPages": f"{INVENTORY_PAGE_START}-{INVENTORY_PAGE_END}",
            "pageBoundaryRepairs": sorted(BOUNDARY_PATCHES),
            "physicalDeliveryCratesExpected": EXPECTED_PHYSICAL_CRATES,
            "originalStoragePalletsReported": ORIGINAL_STORAGE_PALLETS,
            "sourceContainsItemToCrateMap": False,
        },
        "countsByOriginalRoom": dict(sorted(Counter(row["room"] for row in rows).items())),
        "countsByPackType": dict(sorted(Counter(row["pack_type"] for row in rows).items())),
        "highValueInventoryIds": [row["inventory_id"] for row in rows if row["high_value"]],
        "metadata": bundle["metadata"],
    }
    (audit_dir / "inventory-audit.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Provide the inventory PDF path.")
    pdf_path = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parents[1]
    rows = extract(pdf_path)
    bundle = make_bundle(pdf_path, rows)
    output = root / "private-data" / "inventory.generated.json"
    output.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
    write_audit(root, rows, bundle)
    print(f"Extracted and validated {len(rows)} inventory pieces to {output}")


if __name__ == "__main__":
    main()
