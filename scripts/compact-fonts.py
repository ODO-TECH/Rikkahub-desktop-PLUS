"""Convert bundled sfnt fonts to full-glyph WOFF2; preserve catalog IDs and families.

One-time asset maintenance: python -m pip install fonttools brotli
Normal application builds use the checked-in WOFF2 files and do not need Python.
"""
import json
from pathlib import Path
from fontTools.ttLib import TTFont


def compact(directory: Path):
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for source in sorted(directory.iterdir()):
        if source.suffix.lower() not in {".ttf", ".otf"}:
            continue
        target = source.with_suffix(".woff2")
        font = TTFont(source, recalcTimestamp=False)
        font.flavor = "woff2"
        font.save(target)
        restored = TTFont(target, recalcTimestamp=False)
        assert restored.getGlyphOrder() == font.getGlyphOrder(), source
        assert restored.getBestCmap() == font.getBestCmap(), source
        assert restored["hmtx"].metrics == font["hmtx"].metrics, source
        font.close()
        restored.close()
        if target.stat().st_size >= source.stat().st_size:
            target.unlink()
            continue
        entries = [entry for entry in manifest.values() if any(w["file"] == source.name for w in entry.get("weights", []))]
        if not entries:
            entry = manifest.setdefault(source.name, {})
            entry.setdefault("family", f'"{source.stem}", system-ui, sans-serif')
            entry["weights"] = [{"file": target.name, "weight": 400}]
            entries = [entry]
        for entry in entries:
            for weight in entry["weights"]:
                if weight["file"] == source.name:
                    weight["file"] = target.name
        print(f"{source.name}: {source.stat().st_size} -> {target.stat().st_size}", flush=True)
        # All callers use catalog IDs; the ID remains the original manifest key.
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        source.unlink()


if __name__ == "__main__":
    compact(Path(__file__).resolve().parents[1] / "fonts")
