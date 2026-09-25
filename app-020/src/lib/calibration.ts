/**
 * 底图比例双向互校（纯函数，不依赖 DOM / store，便于单测）：
 * - 正校：底图上拉参照线、填真实长度 → 反算 mm/px；
 * - 反校：用已描房间的真实面积 → 反推 mm/px，与当前比例比偏差；
 * - 偏差 > SCALE_TOLERANCE（3%）即视为失准，界面醒目提示、校验判不合规。
 * 参照线一律存底图像素坐标，px→mm 的换算集中在本文件。
 */
import type { AreaCalib, Pt, RefLine, Room, Underlay } from '../model';
import { MM_PER_M, dist, polyAreaM2 } from './geometry';

/** 双向互校容差：实测与当前比例偏差超过 3% 即提示 */
export const SCALE_TOLERANCE = 0.03;

// ---------- 像素坐标 ↔ 图纸毫米坐标 ----------

export function pxToMmPx(px: Pt, u: Underlay): Pt {
  return { x: px.x * u.scaleMmPerPx, y: px.y * u.scaleMmPerPx };
}

export function pxToMm(px: Pt, u: Underlay): Pt {
  return { x: u.offsetX + px.x * u.scaleMmPerPx, y: u.offsetY + px.y * u.scaleMmPerPx };
}

export function mmToPx(mm: Pt, u: Underlay): Pt {
  return { x: (mm.x - u.offsetX) / u.scaleMmPerPx, y: (mm.y - u.offsetY) / u.scaleMmPerPx };
}

export function refLinePxLen(line: RefLine): number {
  return dist(line.a, line.b);
}

export function refLineMmLen(line: RefLine, u: Underlay): number {
  return refLinePxLen(line) * u.scaleMmPerPx;
}

// ---------- 正校：参照线反算比例 ----------

/** 单条参照线反算的 mm/px；像素长度为 0 时返回 null */
export function scaleFromRefLine(line: RefLine): number | null {
  const pxLen = refLinePxLen(line);
  if (!(pxLen > 0) || !(line.realMm > 0)) return null;
  return line.realMm / pxLen;
}

/**
 * 多条参照线联合反算：总真实长度 ÷ 总像素长度（长度加权，
 * 长参照线天然占更大权重，比简单平均更稳）。无有效线时返回 null。
 */
export function scaleFromRefLines(lines: RefLine[]): number | null {
  let real = 0;
  let px = 0;
  for (const l of lines) {
    const len = refLinePxLen(l);
    if (len > 0 && l.realMm > 0) {
      real += l.realMm;
      px += len;
    }
  }
  return px > 0 ? real / px : null;
}

// ---------- 反校：房间真实面积反推比例 ----------

/**
 * 单个房间由真实面积反推的 mm/px（面积按比例平方缩放，故取平方根）。
 * currentScale 为当前底图比例 k：drawnM2 × (kNew ÷ k)² = realM2，故 kNew = k·√(real÷drawn)。
 */
export function scaleFromRoom(room: Room, realM2: number, currentScale: number): number | null {
  if (!(realM2 > 0) || !(currentScale > 0)) return null;
  const drawnM2 = polyAreaM2(room.polygon);
  if (!(drawnM2 > 0)) return null;
  return currentScale * Math.sqrt(realM2 / drawnM2);
}

// ---------- 互校结果 ----------

export type ScaleCheck = {
  kind: 'refline' | 'area';
  id: string; // 参照线 id 或房间 id
  name: string;
  /** 反推出的「应有」mm/px */
  expectedScale: number;
  /** 相对当前比例的偏差（带符号，正=底图被放大/描出来偏小） */
  deviation: number;
  /** 该互校在图纸上的定位点（mm），供定位提示 */
  point: Pt;
};

function deviation(expected: number, current: number): number {
  return expected / current - 1;
}

/**
 * 汇总底图所有互校（参照线 + 面积）。roomsById 用于把面积反校里的
 * roomId / 像素定位换算到当前比例；房间已删除则自动跳过。
 */
export function scaleChecks(u: Underlay, roomById: Map<string, Room>): ScaleCheck[] {
  const checks: ScaleCheck[] = [];
  const current = u.scaleMmPerPx;
  if (current > 0) {
    for (const l of u.refLines) {
      const s = scaleFromRefLine(l);
      if (s == null) continue;
      const mid = pxToMm({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }, u);
      checks.push({
        kind: 'refline',
        id: l.id,
        name: `${(l.realMm / MM_PER_M).toFixed(2)}m 参照线`,
        expectedScale: s,
        deviation: deviation(s, current),
        point: mid,
      });
    }
    for (const c of u.areaCalibs) {
      const room = roomById.get(c.roomId);
      if (!room) continue;
      const s = scaleFromRoom(room, c.realM2, current);
      if (s == null) continue;
      const mid = room.polygon.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
      mid.x /= room.polygon.length;
      mid.y /= room.polygon.length;
      checks.push({
        kind: 'area',
        id: room.id,
        name: `房间「${room.name}」实际 ${c.realM2}㎡`,
        expectedScale: s,
        deviation: deviation(s, current),
        point: mid,
      });
    }
  }
  return checks;
}

/** 偏差绝对值超过 3% 的互校项（含浮点容差：恰好 3.000…% 不算超差） */
export function failingScaleChecks(checks: ScaleCheck[]): ScaleCheck[] {
  return checks.filter((c) => Math.abs(c.deviation) > SCALE_TOLERANCE + 1e-9);
}

/** 多条参照线/面积反推结果的代表值：各自反推比例的长度/面积加权近似——这里用反推值的中位数，避免单条误填拖偏 */
export function representativeScale(checks: ScaleCheck[]): number | null {
  if (!checks.length) return null;
  const sorted = [...checks].map((c) => c.expectedScale).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------- 改比例时的内容变换 ----------

/**
 * 比例 oldScale → newScale，毫米坐标以底图左上角（offsetX/offsetY）为不动点
 * 随底图一起缩放。用于「跟着重算」策略：底图与房间重新对齐，房间面积/疏散距离按真实比例更新。
 */
export function rescaleMmPoint(p: Pt, u: Underlay, newScale: number): Pt {
  if (!(oldScaleValid(u.scaleMmPerPx) && newScale > 0)) return p;
  const k = newScale / u.scaleMmPerPx;
  return {
    x: Math.round(u.offsetX + (p.x - u.offsetX) * k),
    y: Math.round(u.offsetY + (p.y - u.offsetY) * k),
  };
}

export function oldScaleValid(s: number): boolean {
  return Number.isFinite(s) && s > 0;
}

/** 百分比展示：+4.2% / -3.1% */
export function formatDeviation(d: number): string {
  const sign = d > 0 ? '+' : '';
  return `${sign}${(d * 100).toFixed(1)}%`;
}

/** 面积反校入口的空记录工厂（供 UI 建选项） */
export function emptyAreaCalib(roomId: string, realM2: number): AreaCalib {
  return { roomId, realM2 };
}
