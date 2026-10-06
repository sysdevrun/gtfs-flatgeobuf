#!/usr/bin/env bash
# prepare-communes.sh — IGN ADMIN EXPRESS COG → communes-<vintage>.fgb
#
# One FlatGeobuf file in EPSG:4326 with a spatial index: every French commune (métropole + the 5 DROM),
# plus the municipal arrondissements of Paris, Lyon and Marseille, full IGN precision (no simplification).
# Fields: insee (INSEE code), nom (official name), dep (département), kind (COM | ARM).
#
# Usage:   scripts/prepare-communes.sh [vintage] [workdir]        e.g. scripts/prepare-communes.sh 2026-01-01
# Needs:   curl, GDAL ≥ 3.8 (ogr2ogr/ogrinfo with GPKG + FlatGeobuf + SQLite dialect),
#          and an extractor for .7z: bsdtar (macOS `tar`, Debian `libarchive-tools`) or 7z.
# Data:    IGN ADMIN EXPRESS COG, Licence Ouverte Etalab 2.0 — https://geoservices.ign.fr/adminexpress
#          The "COG" edition matches the INSEE Code officiel géographique of that year; do not use
#          "COG CARTO", which is generalised for display and moves borders by tens of metres.
set -euo pipefail

VINTAGE="${1:-2026-01-01}"
WORK="${2:-work}"
EDITION="ADMIN-EXPRESS-COG_4-0__GPKG_WGS84G_FRA_${VINTAGE}"   # GeoPackage edition already in WGS84: no reprojection
URL="https://data.geopf.fr/telechargement/download/ADMIN-EXPRESS-COG/${EDITION}/${EDITION}.7z"
OUT="communes-${VINTAGE}.fgb"

mkdir -p "$WORK"
cd "$WORK"

# 1. Download (≈ 600 MB) and extract the GeoPackage only
if [ ! -f "${EDITION}.7z" ]; then
  echo "downloading $URL"
  curl -fL --retry 3 -o "${EDITION}.7z.part" "$URL" && mv "${EDITION}.7z.part" "${EDITION}.7z"
fi
if command -v bsdtar >/dev/null; then bsdtar -xf "${EDITION}.7z" '*.gpkg'
elif tar --version 2>/dev/null | grep -q bsdtar; then tar -xf "${EDITION}.7z" '*.gpkg'
elif command -v 7z >/dev/null; then 7z x -y "${EDITION}.7z" '*.gpkg' -r >/dev/null
else echo "need bsdtar or 7z to extract ${EDITION}.7z" >&2; exit 1
fi
SRC=$(find . -name '*.gpkg' -path "*${EDITION}*" | head -1)
[ -n "$SRC" ] || { echo "no GeoPackage found in the archive" >&2; exit 1; }
echo "source: $SRC"

# 2. Keep what the assignment needs, repair geometries, one layer for communes + arrondissements
rm -f merged.gpkg
ogr2ogr -f GPKG merged.gpkg "$SRC" -nln commune -nlt MULTIPOLYGON -makevalid -lco GEOMETRY_NAME=geom \
  -dialect SQLITE -sql "SELECT code_insee AS insee, nom_officiel AS nom, code_insee_du_departement AS dep, 'COM' AS kind, geometrie FROM commune"
ogr2ogr -f GPKG -append -update merged.gpkg "$SRC" -nln commune -nlt MULTIPOLYGON -makevalid \
  -dialect SQLITE -sql "SELECT code_insee AS insee, nom_officiel AS nom, substr(code_insee, 1, 2) AS dep, 'ARM' AS kind, geometrie FROM arrondissement_municipal"

# 3. Validation gates: fail rather than ship bad geometry
ogrinfo -q merged.gpkg -dialect SQLITE -sql "
  SELECT kind, count(*) AS n,
         sum(NOT ST_IsValid(geom)) AS invalid,
         sum(geom IS NULL OR ST_IsEmpty(geom)) AS empty,
         count(*) - count(DISTINCT insee) AS duplicates
  FROM commune GROUP BY kind" | tee validation.txt
if grep -Eq '(invalid|empty|duplicates) \(Integer\) = [1-9]' validation.txt; then
  echo "VALIDATION FAILED (see validation.txt)" >&2; exit 1
fi
grep -q 'kind (String) = COM' validation.txt || { echo "no communes found" >&2; exit 1; }

# 4. The delivered asset: FlatGeobuf with its packed Hilbert R-tree (features are reordered along the curve,
#    so neighbouring communes sit next to each other in the file and coalesce into few range requests).
rm -f "../$OUT"
ogr2ogr -f FlatGeobuf "../$OUT" merged.gpkg commune -lco SPATIAL_INDEX=YES \
  -lco TITLE="ADMIN EXPRESS COG ${VINTAGE}: communes + arrondissements municipaux"
ogrinfo -so -al "../$OUT" | grep -E 'Feature Count|Extent'
ls -l "../$OUT"
echo "Serve it as a static file with Range support and no compression (see README)."
