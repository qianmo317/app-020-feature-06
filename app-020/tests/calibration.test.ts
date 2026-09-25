/**
 * 底图比例双向互校验收用例：
 * - 正校：参照线像素长度 + 真实长度 → mm/px（单线/多线加权）；
 * - 反校：房间真实面积 → mm/px（面积按比例平方缩放）；
 * - 互校：偏差 >3% 判失准（SCALE_MISMATCH 进校验结果）；
 * - 改比例：rescale 策略房间/设施以底图左上角为不动点重算，keep 策略坐标不动。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RefLine, Room, Underlay } from '../src/model';
import {
  mmToPx, pxToMm, scaleFromRefLine, scaleFromRefLines, scaleFromRoom,
  scaleChecks, failingScaleChecks, representativeScale, rescaleMmPoint,
  formatDeviation, SCALE_TOLERANCE, refLinePxLen,
} from '../src/lib/calibration';
import { polyAreaM2 } from '../src/lib/geometry';

const M = 1000;

function mkUnderlay(over: Partial<Underlay> = {}): Underlay {
  return {
    key: 'k', wPx: 1000, hPx: 800,
    offsetX: 0, offsetY: 0,
    scaleMmPerPx: 10,
    opacity: 0.5, visible: true,
    refLines: [], areaCalibs: [],
    contentPolicy: 'keep', scaleBasis: 'manual',
    ...over,
  };
}

function mkRectRoomM(w: number, h: number): Room {
  return {
    id: 'r1', name: '房', usage: 'office',
    polygon: [
      { x: 0, y: 0 }, { x: w * M, y: 0 },
      { x: w * M, y: h * M }, { x: 0, y: h * M },
    ],
    areaM2: w * h,
  };
}

describe('参照线正校（像素长度 → mm/px）', () => {
  it('C1 单条线：真实 5m 落在 500px 上 → 10 mm/px', () => {
    const l: RefLine = { id: 'l1', a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, realMm: 5000 };
    expect(scaleFromRefLine(l)).toBeCloseTo(10, 10);
  });

  it('C2 斜线段用欧氏像素长度', () => {
    const l: RefLine = { id: 'l1', a: { x: 0, y: 0 }, b: { x: 300, y: 400 }, realMm: 4000 };
    expect(refLinePxLen(l)).toBeCloseTo(500);
    expect(scaleFromRefLine(l)).toBeCloseTo(8, 10);
  });

  it('C3 零长度像素/非正真实长度 → null（防止除零）', () => {
    expect(scaleFromRefLine({ id: 'x', a: { x: 1, y: 1 }, b: { x: 1, y: 1 }, realMm: 1000 })).toBeNull();
    expect(scaleFromRefLine({ id: 'x', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, realMm: 0 })).toBeNull();
  });

  it('C4 多线联合反算按总长度加权（长线权重大），不是简单平均', () => {
    // 线1：1000px = 10m → 10；线2：10px = 0.2m → 20。短而不准的线影响应很小
    const lines: RefLine[] = [
      { id: 'a', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, realMm: 10000 },
      { id: 'b', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, realMm: 200 },
    ];
    const s = scaleFromRefLines(lines)!;
    expect(s).toBeCloseTo(10200 / 1010, 6); // ≈ 10.099，明显贴近长线的 10
    expect(Math.abs(s - 10)).toBeLessThan(0.15);
  });

  it('C5 px↔mm 互逆（含偏移）', () => {
    const u = mkUnderlay({ offsetX: 3000, offsetY: 2000, scaleMmPerPx: 5 });
    const mm = { x: 5500, y: 4500 };
    expect(pxToMm(mmToPx(mm, u), u)).toEqual(mm);
  });
});

describe('房间面积反校（真实面积 → mm/px）', () => {
  it('C6 图上 8m×6m=48㎡，真实面积 75㎡ → 比例应放大 1.25 倍', () => {
    const room = mkRectRoomM(8, 6); // drawnM2=48
    const s = scaleFromRoom(room, 75, 10)!;
    expect(s).toBeCloseTo(10 * 1.25, 6);
    // 用该比例重算多边形，面积恰为真实面积
    const k = s / 10;
    const rescaled = room.polygon.map((p) => ({ x: p.x * k, y: p.y * k }));
    expect(polyAreaM2(rescaled)).toBeCloseTo(75, 6);
  });

  it('C7 真实 48㎡、图上 48㎡ → 比例不变（10 mm/px）', () => {
    expect(scaleFromRoom(mkRectRoomM(8, 6), 48, 10)).toBeCloseTo(10, 6);
  });

  it('C8 非法面积/退化多边形/非正比例 → null', () => {
    expect(scaleFromRoom(mkRectRoomM(8, 6), 0, 10)).toBeNull();
    expect(scaleFromRoom(mkRectRoomM(8, 6), 48, 0)).toBeNull();
    const degenerate: Room = {
      id: 'd', name: 'd', usage: 'office',
      polygon: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 0 }], areaM2: 0,
    };
    expect(scaleFromRoom(degenerate, 10, 10)).toBeNull();
  });
});

describe('互校结果与 3% 阈值', () => {
  it('C9 参照线反推与当前比例一致 → 偏差 0，不超差', () => {
    const u = mkUnderlay({
      scaleMmPerPx: 10,
      refLines: [{ id: 'l1', a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, realMm: 5000 }],
    });
    const checks = scaleChecks(u, new Map());
    expect(checks).toHaveLength(1);
    expect(checks[0].deviation).toBeCloseTo(0, 10);
    expect(failingScaleChecks(checks)).toHaveLength(0);
  });

  it('C10 偏差恰好 +3% 不报（边界），超过 3% 才报', () => {
    // 10 mm/px 当前；参照线 500px 真实 5150mm → 反推 10.3 → +3%
    const u3 = mkUnderlay({
      scaleMmPerPx: 10,
      refLines: [{ id: 'l', a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, realMm: 5150 }],
    });
    expect(failingScaleChecks(scaleChecks(u3, new Map()))).toHaveLength(0);
    const uOver = mkUnderlay({
      scaleMmPerPx: 10,
      refLines: [{ id: 'l', a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, realMm: 5200 }], // 10.4 → +4%
    });
    expect(failingScaleChecks(scaleChecks(uOver, new Map()))).toHaveLength(1);
  });

  it('C11 面积反校项带房间定位点，房间删除后自动跳过', () => {
    const room = mkRectRoomM(8, 6);
    const u = mkUnderlay({
      scaleMmPerPx: 10,
      areaCalibs: [{ roomId: 'r1', realM2: 75 }, { roomId: 'gone', realM2: 10 }],
    });
    const checks = scaleChecks(u, new Map([['r1', room]]));
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe('area');
    expect(checks[0].deviation).toBeCloseTo(0.25, 6);
    expect(checks[0].point).toEqual({ x: 4000, y: 3000 }); // 矩形中心
    expect(failingScaleChecks(checks)).toHaveLength(1);
  });

  it('C12 负偏差：底图被缩小，描出的面积偏大，偏差为负且超差时报出', () => {
    const room = mkRectRoomM(8, 6); // 48㎡
    const u = mkUnderlay({ scaleMmPerPx: 10, areaCalibs: [{ roomId: 'r1', realM2: 40 }] });
    const [c] = scaleChecks(u, new Map([['r1', room]]));
    expect(c.deviation).toBeLessThan(0);
    expect(Math.abs(c.deviation)).toBeGreaterThan(SCALE_TOLERANCE);
  });
  it('C13 代表比例取反推值中位数，单条误填不拖偏全部', () => {
    const u = mkUnderlay({
      scaleMmPerPx: 10,
      refLines: [
        { id: 'a', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, realMm: 9950 }, // 9.95
        { id: 'b', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, realMm: 10050 }, // 10.05
        { id: 'c', a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, realMm: 20000 }, // 20（误填）
      ],
    });
    expect(representativeScale(scaleChecks(u, new Map()))).toBeCloseTo(10.05, 6);
  });

  it('C14 formatDeviation 带正负号', () => {
    expect(formatDeviation(0.042)).toBe('+4.2%');
    expect(formatDeviation(-0.031)).toBe('-3.1%');
  });
});

describe('改比例时的内容变换（rescale 策略）', () => {
  it('C15 以底图左上角为不动点：offset 处不动，其余按比例线性缩放', () => {
    const u = mkUnderlay({ offsetX: 1000, offsetY: 2000, scaleMmPerPx: 10 });
    expect(rescaleMmPoint({ x: 1000, y: 2000 }, u, 12)).toEqual({ x: 1000, y: 2000 });
    expect(rescaleMmPoint({ x: 11000, y: 22000 }, u, 12)).toEqual({ x: 13000, y: 26000 });
  });
});

// ---------- store 层：策略落地与互校进校验 ----------

import {
  getState, addBuilding, addFloor, addRoom, addFacility, setUnderlay,
  setUnderlayScale, setContentPolicy, rescaleFloorContent,
  addRefLine, setAreaCalib, deleteBuilding,
} from '../src/store/store';
import { validateFloor } from '../src/lib/engine';
import { DEFAULT_RULES } from '../src/rules/defaults';

let bid = '';
let fid = '';

beforeEach(() => {
  for (const b of [...getState().buildings]) deleteBuilding(b.id);
  bid = addBuilding('测试楼', 'office');
  fid = addFloor(bid, 1);
  setUnderlay(fid, mkUnderlay({ contentPolicy: 'keep' }));
});

describe('store：改比例时 rescale / keep 两种策略', () => {
  it('C16 keep（默认/旧行为）：改比例后房间与设施坐标不动', () => {
    const rid = addRoom(fid, [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }], '房', 'office');
    addFacility(fid, 'extinguisher', 4000, 3000);
    setUnderlayScale(fid, 12, 'manual');
    const f = getState().floors[fid];
    const r = f.rooms.find((x) => x.id === rid)!;
    expect(r.polygon[1]).toEqual({ x: 8000, y: 0 });
    expect(r.areaM2).toBeCloseTo(48, 6);
    expect(f.facilities[0].x).toBe(4000);
  });

  it('C17 rescale：房间/设施以底图左上角不动点缩放，面积重算，人数等属性保留', () => {
    const rid = addRoom(fid, [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }], '房', 'office');
    addFacility(fid, 'extinguisher', 4000, 3000);
    setContentPolicy(fid, 'rescale');
    setUnderlayScale(fid, 12, 'manual');
    const f = getState().floors[fid];
    const r = f.rooms.find((x) => x.id === rid)!;
    expect(r.polygon[1]).toEqual({ x: 9600, y: 0 }); // 8000 * 1.2
    expect(r.areaM2).toBeCloseTo(48 * 1.44, 5); // 面积按平方
    expect(f.facilities[0].x).toBe(4800);
    // 比例来源写明
    expect(f.underlay!.scaleBasis).toBe('manual');
  });

  it('C18 keep 策略下「立即重算已有图形」一次性把内容拉到当前比例', () => {
    const rid = addRoom(fid, [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 10000 }, { x: 0, y: 10000 }], '房', 'office');
    rescaleFloorContent(fid, 11);
    const r = getState().floors[fid].rooms.find((x) => x.id === rid)!;
    expect(r.polygon[2]).toEqual({ x: 11000, y: 11000 });
  });
});

describe('store：参照线/面积反校与校验联动', () => {
  it('C19 参照线反算写比例；留下与当前比例矛盾的参照线时 validateFloor 报 SCALE_MISMATCH（error）', () => {
    // 场景：用户在 10 mm/px 下已描图，事后拉参照线发现真实比例应是 10.4，
    // 但选择「保持原样」（只更新参照线记录，不采用新比例）→ 互校超差，校验不合规
    addRefLine(fid, { a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, realMm: 5200 });
    const u0 = getState().floors[fid].underlay!;
    expect(scaleFromRefLines(u0.refLines)).toBeCloseTo(10.4, 6);
    // 保持当前 10 mm/px 不动（模拟用户暂不采用）
    const f = getState().floors[fid];
    const res = validateFloor(f, DEFAULT_RULES.office);
    const item = res.items.find((i) => i.type === 'SCALE_MISMATCH');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('error');
    expect(item!.value).toBeCloseTo(10.4, 6); // 反推的应有比例
    expect(item!.limit).toBe(10); // 当前比例
    expect(res.pass).toBe(false);

    // 采用反算比例后参照线与当前一致，失准项消失
    setUnderlayScale(fid, scaleFromRefLines(getState().floors[fid].underlay!.refLines)!, 'reflines');
    const res2 = validateFloor(getState().floors[fid], DEFAULT_RULES.office);
    expect(res2.items.some((i) => i.type === 'SCALE_MISMATCH')).toBe(false);
  });

  it('C20 面积反校不自动改比例；差 ≤3% 时校验通过', () => {
    addRoom(fid, [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }], '房', 'office');
    setAreaCalib(fid, getState().floors[fid].rooms[0].id, 48.5); // 图上 48，真实 48.5 → +0.5%
    const f = getState().floors[fid];
    expect(f.underlay!.scaleMmPerPx).toBe(10); // 反校不改比例
    const res = validateFloor(f, DEFAULT_RULES.office);
    expect(res.items.some((i) => i.type === 'SCALE_MISMATCH')).toBe(false);
  });
});
