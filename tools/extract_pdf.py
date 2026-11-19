"""Dump everything machine-readable from an MPMB character sheet PDF into a folder.

Usage:
    python tools/extract_pdf.py "DataInspo/MPMB's Character Record Sheet ....pdf" build/mpmb

Writes:
    <out>/js/*.js                    document-level JavaScript (all the sheet's list data and code)
    <out>/pdf/player-reference.txt   text of the Player Reference page (conditions, actions, ...)
    <out>/pdf/option-lists.json      every distinct drop-down option list, with the fields that use it
    <out>/pdf/fields/*.txt           stored sheet data, incl. the imported add-on scripts (all WotC content)
    <out>/pdf/embedded/*             files embedded in the PDF (the sheet's FAQ, import script)

Then run:  node tools/extract-mpmb-data.js <out> .

Requires: pip install pypdf
"""
import json
import os
import re
import sys

from pypdf import PdfReader
from pypdf._page import PageObject


def walk_name_tree(node, acc):
    node = node.get_object()
    if "/Names" in node:
        arr = node["/Names"]
        for i in range(0, len(arr), 2):
            acc.append((str(arr[i]), arr[i + 1]))
    for kid in node.get("/Kids", []):
        walk_name_tree(kid, acc)


def name_tree(names, key):
    acc = []
    if names and key in names:
        walk_name_tree(names[key], acc)
    return acc


def js_text(action):
    js = action.get_object().get("/JS")
    if js is None:
        return ""
    js = js.get_object()
    data = js.get_data() if hasattr(js, "get_data") else str(js).encode("utf-8", "replace")
    if data[:2] in (b"\xfe\xff", b"\xff\xfe"):
        return data.decode("utf-16")
    return data.decode("latin-1")


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9_. -]+", "_", name)[:100]


def write(path, content, mode="w"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode, **({"encoding": "utf-8"} if "b" not in mode else {})) as f:
        f.write(content)


def dump_javascript(names, out):
    entries = name_tree(names, "/JavaScript")
    for name, action in entries:
        write(os.path.join(out, "js", safe_name(name) + ".js"), js_text(action))
    print(f"{len(entries):>5}  js/*.js")


def dump_player_reference(reader, names, out):
    # The reference sheet is a page template ("PRsheet"); fall back to scanning the visible pages.
    text = ""
    for name, ref in name_tree(names, "/Templates"):
        if name == "PRsheet":
            page = PageObject(reader)
            page.update(ref.get_object())
            text = page.extract_text()
    if not text:
        text = next((p.extract_text() for p in reader.pages if "PLAYER REFERENCE" in (p.extract_text() or "")), "")
    write(os.path.join(out, "pdf", "player-reference.txt"), text)
    print(f"{len(text):>5}  pdf/player-reference.txt (characters)")


def dump_option_lists(reader, out):
    lists = {}
    for field, obj in (reader.get_fields() or {}).items():
        opts = obj.get("/Opt")
        if not opts:
            continue
        values = [str(o[-1] if isinstance(o, list) else o) for o in opts]
        entry = lists.setdefault(json.dumps(values, ensure_ascii=False), {"fields": [], "tooltip": None, "options": values})
        entry["fields"].append(field)
        if obj.get("/TU") and not entry["tooltip"]:
            entry["tooltip"] = str(obj.get("/TU"))
    result = sorted(lists.values(), key=lambda e: -len(e["options"]))
    write(os.path.join(out, "pdf", "option-lists.json"), json.dumps(result, indent=1, ensure_ascii=False))
    print(f"{len(result):>5}  pdf/option-lists.json (distinct lists)")


def dump_stored_fields(reader, out):
    # MPMB keeps state in hidden fields, most importantly "User_Imported_Files.Stringified": the add-on
    # scripts imported into the sheet (here "all_WotC_pub+UA", i.e. the full published-content add-on).
    count = 0
    for field, obj in (reader.get_fields() or {}).items():
        if not (field.endswith(".Stringified") or field == "User Script"):
            continue
        value = obj.get("/V")
        if value is None:
            continue
        value = value.get_object()
        text = value.get_data().decode("utf-8", "replace") if hasattr(value, "get_data") else str(value)
        if text.strip():
            write(os.path.join(out, "pdf", "fields", safe_name(field) + ".txt"), text)
            count += 1
    print(f"{count:>5}  pdf/fields/*.txt (stored sheet data, incl. imported add-on scripts)")


def dump_embedded(names, out):
    files = name_tree(names, "/EmbeddedFiles")
    for name, spec in files:
        data = spec.get_object()["/EF"]["/F"].get_object().get_data()
        write(os.path.join(out, "pdf", "embedded", safe_name(name)), data, "wb")
    print(f"{len(files):>5}  pdf/embedded/*")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pdf_path, out = sys.argv[1], sys.argv[2]
    reader = PdfReader(pdf_path)
    names = reader.trailer["/Root"].get("/Names")
    names = names.get_object() if names else None
    if not names or "/JavaScript" not in names:
        sys.exit("No document-level JavaScript found in " + pdf_path)
    dump_javascript(names, out)
    dump_player_reference(reader, names, out)
    dump_option_lists(reader, out)
    dump_stored_fields(reader, out)
    dump_embedded(names, out)


if __name__ == "__main__":
    main()
