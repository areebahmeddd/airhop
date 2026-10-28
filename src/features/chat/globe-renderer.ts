// Draws one frame of the globe picker into a Skia picture, on the UI thread.
//
// A port of bitchat-ios's GlobeRenderer, in its order: water, graticule, land
// fills, coastlines, borders, the limb, city dots and names, the selected cell
// and its eight neighbours with their labels, then the crosshair. It leaves out
// bitchat's decoration (a starfield, an atmosphere glow, gradient shading),
// which Airhop's flat monochrome has no place for; the limb is a hairline
// instead. Lakes are filled as water, where bitchat paints the Caspian as land.
//
// The paints arrive ready (globe-view.tsx), widths included; only alpha is
// changed here, per label and per city as they fade toward the limb.

import { geohashBounds, geohashNeighbours } from "@utils/geohash-grid";
import type { Camera } from "@utils/globe-camera";
import {
  clipPolygon,
  clipRectFor,
  clipSegment,
  fillPolygon,
  frontRuns,
  projectedFillNeedsInversion,
  type ClipRect,
  type DiscRing,
} from "@utils/globe-geometry";
import {
  makeProjector,
  project,
  projectPrepared,
  projectRaw,
  type Projection,
  type Projector,
} from "@utils/globe-math";
import type { DetailFrame } from "@utils/globe-motion";
import type { RingSet, WorldData } from "@utils/world-data";
import {
  FillType,
  Skia,
  type SkCanvas,
  type SkFont,
  type SkPaint,
  type SkPathBuilder,
  type SkPicture,
  type SkPictureRecorder,
} from "react-native-skia";

export interface GlobeInk {
  water: SkPaint;
  land: SkPaint;
  coast: SkPaint;
  border: SkPaint;
  graticule: SkPaint;
  limb: SkPaint;
  gridFill: SkPaint;
  gridStroke: SkPaint;
  selectedFill: SkPaint;
  selectedHalo: SkPaint;
  selectedStroke: SkPaint;
  city: SkPaint;
  capital: SkPaint;
  label: SkPaint;
  selectedLabel: SkPaint;
  halo: SkPaint;
  crosshair: SkPaint;
  crosshairDot: SkPaint;
  cityFont: SkFont;
  cellFont: SkFont;
  selectedFont: SkFont;
}

export interface Frame {
  camera: Camera;
  detail: DetailFrame;
  width: number;
  height: number;
}

// Clipped segments joined into polylines: a run's consecutive segments share
// an end, so the pen only lifts where clipping cut it.
function appendRuns(
  path: SkPathBuilder,
  runs: number[][],
  cx: number,
  cy: number,
  r: number,
  clip: ClipRect,
  seg: number[],
): void {
  "worklet";
  for (const run of runs) {
    let penX = NaN;
    let penY = NaN;
    for (let k = 2; k + 1 < run.length; k += 2) {
      if (
        !clipSegment(
          cx + run[k - 2] * r,
          cy + run[k - 1] * r,
          cx + run[k] * r,
          cy + run[k + 1] * r,
          clip,
          seg,
        )
      ) {
        penX = NaN;
        continue;
      }
      if (seg[0] !== penX || seg[1] !== penY) path.moveTo(seg[0], seg[1]);
      path.lineTo(seg[2], seg[3]);
      penX = seg[2];
      penY = seg[3];
    }
  }
}

function addPolygon(path: SkPathBuilder, poly: number[]): void {
  "worklet";
  path.moveTo(poly[0], poly[1]);
  for (let i = 2; i < poly.length; i += 2) path.lineTo(poly[i], poly[i + 1]);
  path.close();
}

function drawGraticule(
  canvas: SkCanvas,
  f: Frame,
  ink: GlobeInk,
  cx: number,
  cy: number,
  r: number,
  clip: ClipRect,
  seg: number[],
): void {
  "worklet";
  const { lat: cLat, lon: cLon } = f.camera;
  const step = f.detail.graticuleStepDegrees;
  const path = Skia.PathBuilder.Make();
  const trace = (
    fixedIsLat: boolean,
    fixed: number,
    from: number,
    to: number,
  ) => {
    let prev: Projection | null = null;
    let penX = NaN;
    let penY = NaN;
    for (let v = from; v <= to; v += step) {
      const p = fixedIsLat
        ? project(fixed, v, cLat, cLon)
        : project(v, fixed, cLat, cLon);
      if (p === null || p.cosC <= 0.02) {
        prev = null;
        continue;
      }
      if (
        prev !== null &&
        clipSegment(
          cx + prev.x * r,
          cy + prev.y * r,
          cx + p.x * r,
          cy + p.y * r,
          clip,
          seg,
        )
      ) {
        if (seg[0] !== penX || seg[1] !== penY) path.moveTo(seg[0], seg[1]);
        path.lineTo(seg[2], seg[3]);
        penX = seg[2];
        penY = seg[3];
      }
      prev = p;
    }
  };
  for (let lat = -75; lat <= 75; lat += 15) trace(true, lat, -180, 180);
  for (let lon = -180; lon < 180; lon += 15) trace(false, lon, -90, 90);
  canvas.drawPath(path.build(), ink.graticule);
}

// One land ring, or one lake. Fills that need the horizon closure inverted are
// drawn on their own, even-odd against the disc; the rest share one path.
function drawRings(
  canvas: SkCanvas,
  rings: RingSet,
  holes: boolean,
  f: Frame,
  projector: Projector,
  fillPaint: SkPaint,
  coastlines: SkPathBuilder,
  cx: number,
  cy: number,
  r: number,
  clip: ClipRect,
  seg: number[],
): void {
  "worklet";
  const fills = Skia.PathBuilder.Make();
  const out = { x: 0, y: 0, cosC: 0 };
  const pts: DiscRing = { x: [], y: [], front: [], length: 0 };
  for (let ring = 0; ring < rings.count; ring++) {
    if ((rings.holes[ring] === 1) !== holes) continue;
    const start = rings.starts[ring];
    const count = rings.starts[ring + 1] - start;
    const stride = count >= 64 ? f.detail.landPointStride : 1;
    const n = Math.floor((count - 1) / stride) + 1;
    if (n < 3) continue;
    let anyFront = false;
    let anyBack = false;
    let anyFacing = false;
    for (let i = 0; i < n; i++) {
      projectPrepared(
        projector,
        rings.terms,
        start + Math.min(i * stride, count - 1),
        out,
      );
      if (out.cosC >= 0) anyFront = true;
      else anyBack = true;
      pts.x[i] = out.x;
      pts.y[i] = out.y;
      pts.front[i] = out.cosC > 0.005;
      if (pts.front[i]) anyFacing = true;
    }
    pts.length = n;
    if (!anyFront) continue;
    appendRuns(coastlines, frontRuns(pts), cx, cy, r, clip, seg);
    // A ring grazing the limb has no point clearly in front, and closing it
    // along the horizon would fill an arc of the disc. As bitchat guards it.
    if (!anyFacing) continue;

    const polygon = fillPolygon(pts, cx, cy, r);
    const invert =
      anyBack &&
      projectedFillNeedsInversion(
        polygon,
        rings,
        ring,
        cx,
        cy,
        r,
        f.camera.lat,
        f.camera.lon,
      );
    const clipped = clipPolygon(polygon, clip);
    if (clipped.length < 6) continue;
    if (!invert) {
      addPolygon(fills, clipped);
      continue;
    }
    const inverted = Skia.PathBuilder.Make();
    inverted.setFillType(FillType.EvenOdd);
    const discCoversClip =
      cx - r <= clip.left &&
      cx + r >= clip.right &&
      cy - r <= clip.top &&
      cy + r >= clip.bottom;
    if (discCoversClip) {
      inverted.addRect(
        Skia.XYWHRect(
          clip.left,
          clip.top,
          clip.right - clip.left,
          clip.bottom - clip.top,
        ),
      );
    } else {
      inverted.addCircle(cx, cy, r);
    }
    addPolygon(inverted, clipped);
    canvas.drawPath(inverted.build(), fillPaint);
  }
  canvas.drawPath(fills.build(), fillPaint);
}

function drawBorders(
  canvas: SkCanvas,
  borders: RingSet,
  projector: Projector,
  ink: GlobeInk,
  cx: number,
  cy: number,
  r: number,
  clip: ClipRect,
  seg: number[],
): void {
  "worklet";
  const path = Skia.PathBuilder.Make();
  const out = { x: 0, y: 0, cosC: 0 };
  const pts: DiscRing = { x: [], y: [], front: [], length: 0 };
  for (let line = 0; line < borders.count; line++) {
    const start = borders.starts[line];
    const count = borders.starts[line + 1] - start;
    let anyVisible = false;
    for (let i = 0; i < count; i++) {
      projectPrepared(projector, borders.terms, start + i, out);
      if (out.cosC >= 0) anyVisible = true;
      pts.x[i] = out.x;
      pts.y[i] = out.y;
      pts.front[i] = out.cosC > 0.005;
    }
    pts.length = count;
    if (anyVisible)
      appendRuns(path, frontRuns(pts, false), cx, cy, r, clip, seg);
  }
  canvas.drawPath(path.build(), ink.border);
}

// Text centred vertically on `y`, with a halo in the water colour so it reads
// over land, lines and the limb alike.
function drawLabel(
  canvas: SkCanvas,
  text: string,
  x: number,
  y: number,
  centred: boolean,
  font: SkFont,
  paint: SkPaint,
  halo: SkPaint,
): void {
  "worklet";
  const metrics = font.getMetrics();
  const baseline = y - (metrics.ascent + metrics.descent) / 2;
  const left = centred ? x - font.getTextWidth(text) / 2 : x;
  canvas.drawText(text, left, baseline, halo, font);
  canvas.drawText(text, left, baseline, paint, font);
}

function drawCities(
  canvas: SkCanvas,
  world: WorldData,
  f: Frame,
  projector: Projector,
  ink: GlobeInk,
  cx: number,
  cy: number,
  r: number,
): void {
  "worklet";
  const { cities } = world;
  const zoom = f.camera.zoom;
  // Natural Earth ranks 0 to 10; more of them as the globe closes in.
  const maxRank = zoom < 2 ? 1 : zoom < 8 ? 3 : zoom < 40 ? 4 : 10;
  const out = { x: 0, y: 0, cosC: 0 };
  for (let i = 0; i < cities.count; i++) {
    if (cities.ranks[i] > maxRank) continue;
    projectPrepared(projector, cities.terms, i, out);
    if (out.cosC < 0.03) continue;
    const sx = cx + out.x * r;
    const sy = cy + out.y * r;
    if (sx < -50 || sx > f.width + 50 || sy < -50 || sy > f.height + 50) {
      continue;
    }
    // Fades toward the limb.
    const alpha = Math.min(Math.max(out.cosC, 0.25), 1);
    const capital = cities.capital[i] === 1;
    const important = capital || cities.megacity[i] === 1;
    const radius = important ? 2.6 : 1.8;
    const dot = capital ? ink.capital : ink.city;
    dot.setAlphaf(capital ? alpha : alpha * 0.85);
    canvas.drawCircle(sx, sy, radius, dot);
    if (f.detail.showCityLabels && (zoom >= 6 || (important && zoom >= 2.5))) {
      ink.label.setAlphaf((200 / 255) * alpha);
      ink.halo.setAlphaf((140 / 255) * alpha);
      drawLabel(
        canvas,
        cities.names[i],
        sx + radius + 3,
        sy,
        false,
        ink.cityFont,
        ink.label,
        ink.halo,
      );
    }
  }
}

function drawCells(
  canvas: SkCanvas,
  f: Frame,
  ink: GlobeInk,
  cx: number,
  cy: number,
  r: number,
  clip: ClipRect,
  seg: number[],
): void {
  "worklet";
  const { lat: cLat, lon: cLon, selected } = f.camera;
  if (selected.length === 0) return;
  const cells = [selected];
  for (const n of geohashNeighbours(selected)) {
    if (!cells.includes(n.geohash)) cells.push(n.geohash);
  }
  // Neighbours first, so the selected outline is never painted over.
  cells.reverse();
  const pts: DiscRing = { x: [], y: [], front: [], length: 0 };
  for (const cell of cells) {
    const isSelected = cell === selected;
    const b = geohashBounds(cell);
    const spanLat = b.maxLat - b.minLat;
    const spanLon = b.maxLon - b.minLon;
    // Edges are sampled so they curve with the sphere: more steps for a
    // bigger cell, which bends more.
    const steps = Math.min(Math.max(Math.ceil(spanLat / 1.5), 4), 48);
    let n = 0;
    let anyFront = false;
    const add = (lat: number, rawLon: number) => {
      // Continuous across the antimeridian relative to the view.
      let lon = rawLon;
      while (lon - cLon > 180) lon -= 360;
      while (lon - cLon < -180) lon += 360;
      const p = projectRaw(lat, lon, cLat, cLon);
      pts.x[n] = p.x;
      pts.y[n] = p.y;
      pts.front[n] = p.cosC >= 0.005;
      if (pts.front[n]) anyFront = true;
      n++;
    };
    // North edge west to east, east edge down, south edge back, west edge up.
    // The last corner is left out; frontRuns closes the ring.
    for (let s = 0; s <= steps; s++) {
      add(b.maxLat, b.minLon + (spanLon * s) / steps);
    }
    for (let s = 1; s <= steps; s++) {
      add(b.maxLat - (spanLat * s) / steps, b.maxLon);
    }
    for (let s = 1; s <= steps; s++) {
      add(b.minLat, b.maxLon - (spanLon * s) / steps);
    }
    for (let s = 1; s < steps; s++) {
      add(b.minLat + (spanLat * s) / steps, b.minLon);
    }
    pts.length = n;
    if (!anyFront) continue;

    const outline = Skia.PathBuilder.Make();
    appendRuns(outline, frontRuns(pts), cx, cy, r, clip, seg);
    const poly = clipPolygon(fillPolygon(pts, cx, cy, r), clip);
    if (poly.length >= 6) {
      const fill = Skia.PathBuilder.Make();
      addPolygon(fill, poly);
      canvas.drawPath(
        fill.build(),
        isSelected ? ink.selectedFill : ink.gridFill,
      );
    }
    const path = outline.build();
    if (isSelected) {
      canvas.drawPath(path, ink.selectedHalo);
      canvas.drawPath(path, ink.selectedStroke);
    } else {
      canvas.drawPath(path, ink.gridStroke);
    }
  }

  for (const cell of cells) {
    const isSelected = cell === selected;
    const b = geohashBounds(cell);
    const p = project(
      (b.minLat + b.maxLat) / 2,
      (b.minLon + b.maxLon) / 2,
      cLat,
      cLon,
    );
    if (p === null || p.cosC < 0.08) continue;
    ink.halo.setAlphaf(isSelected ? 200 / 255 : 120 / 255);
    if (!isSelected) {
      ink.label.setAlphaf((160 / 255) * Math.min(Math.max(p.cosC, 0.4), 1));
    }
    drawLabel(
      canvas,
      cell,
      cx + p.x * r,
      cy + p.y * r,
      true,
      isSelected ? ink.selectedFont : ink.cellFont,
      isSelected ? ink.selectedLabel : ink.label,
      ink.halo,
    );
  }
}

// Four ticks round a dot at the screen centre, bitchat's mark. Static rather
// than pulsing at rest: the selection does not need announcing twice.
function drawCrosshair(
  canvas: SkCanvas,
  ink: GlobeInk,
  cx: number,
  cy: number,
): void {
  "worklet";
  const gap = 5;
  const len = 9;
  const path = Skia.PathBuilder.Make();
  path.moveTo(cx - gap - len, cy).lineTo(cx - gap, cy);
  path.moveTo(cx + gap, cy).lineTo(cx + gap + len, cy);
  path.moveTo(cx, cy - gap - len).lineTo(cx, cy - gap);
  path.moveTo(cx, cy + gap).lineTo(cx, cy + gap + len);
  canvas.drawPath(path.build(), ink.crosshair);
  canvas.drawCircle(cx, cy, 1.8, ink.crosshairDot);
}

export function renderGlobe(
  recorder: SkPictureRecorder,
  world: WorldData,
  f: Frame,
  ink: GlobeInk,
): SkPicture {
  "worklet";
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(0, 0, Math.max(f.width, 1), Math.max(f.height, 1)),
  );
  const r = f.camera.baseRadius * f.camera.zoom;
  if (r > 0 && f.width > 0 && f.height > 0) {
    const cx = f.width / 2;
    const cy = f.height / 2;
    const clip = clipRectFor(f.width, f.height);
    const seg = [0, 0, 0, 0];
    const projector = makeProjector(f.camera.lat, f.camera.lon);
    // Past this the disc covers the whole screen, and a circle that large
    // only costs the rasteriser precision.
    const coverRadius = Math.sqrt(cx * cx + cy * cy) + 2;
    const discCoversScreen = r > coverRadius;

    if (discCoversScreen) {
      canvas.drawRect(Skia.XYWHRect(0, 0, f.width, f.height), ink.water);
    } else {
      canvas.drawCircle(cx, cy, r, ink.water);
    }
    drawGraticule(canvas, f, ink, cx, cy, r, clip, seg);

    // Every fill first and every coastline after, so a continent's fill never
    // covers an island's outline drawn before it.
    const coastlines = Skia.PathBuilder.Make();
    drawRings(
      canvas,
      world.land,
      false,
      f,
      projector,
      ink.land,
      coastlines,
      cx,
      cy,
      r,
      clip,
      seg,
    );
    drawRings(
      canvas,
      world.land,
      true,
      f,
      projector,
      ink.water,
      coastlines,
      cx,
      cy,
      r,
      clip,
      seg,
    );
    canvas.drawPath(coastlines.build(), ink.coast);

    if (f.detail.showBorders) {
      drawBorders(canvas, world.borders, projector, ink, cx, cy, r, clip, seg);
    }
    if (!discCoversScreen) canvas.drawCircle(cx, cy, r, ink.limb);

    drawCities(canvas, world, f, projector, ink, cx, cy, r);
    drawCells(canvas, f, ink, cx, cy, r, clip, seg);
    drawCrosshair(canvas, ink, cx, cy);
  }
  return recorder.finishRecordingAsPicture();
}
