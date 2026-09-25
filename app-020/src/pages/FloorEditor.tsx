import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Facility, Floor, Pt, Room, RoomUsage, Underlay } from '../model';
import { USAGE_LABELS, FACILITY_LABELS, SCALE_BASIS_LABELS } from '../model';
import {
  addRoom, addFacility, deleteFacility, deleteRoom, moveFacility, moveRoom, updateRoom,
  updateFacility, setUnderlay, setUnderlayScale, setLastValidation, updateUnderlay, setContentPolicy,
  rescaleFloorContent, addRefLine, updateRefLine, deleteRefLine, setAreaCalib, deleteAreaCalib,
  useStore, addCheck, deleteCheck,
} from '../store/store';
import { floorLabel } from '../store/id';
import { getBlob, putBlob, compressImage } from '../store/db';
import { uid } from '../store/id';
import { bboxOf, MM_PER_M } from '../lib/geometry';
import { computeCoverage, validateFloor } from '../lib/engine';
import {
  mmToPx, pxToMm, refLinePxLen, scaleFromRefLines, scaleFromRoom,
  scaleChecks, failingScaleChecks, representativeScale, formatDeviation, SCALE_TOLERANCE,
} from '../lib/calibration';;
import { FloorPlan, mmFromEvent, wheelZoom, type DragState, type Selection, type Tool, type View } from '../components/FloorPlan';
import { FacilityGlyph, USAGE_FILLS } from '../components/symbols';

import { ValidationPanel } from '../components/ValidationPanel';
import { Link } from '../router';

const SNAP = 100; // 绘制/拖动吸附 0.1m
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const ROOM_USAGES: RoomUsage[] = ['office', 'retail', 'storage', 'ward', 'other'];
const FAC_KINDS = ['extinguisher', 'hydrant', 'exit_sign', 'emergency_light', 'exit', 'sprinkler'] as const;

/** 参照线确认后的像素落点（参照线不吸附，要贴合图片上的墙线） */
type CalibDraft = { aPx: Pt; bPx: Pt | null } | null;

type Props = { floorId: string };

export function FloorEditor({ floorId }: Props) {
  const floor = useStore((s) => s.floors[floorId]);
  const building = useStore((s) => s.buildings.find((b) => b.id === floor?.buildingId));
  const rules = useStore((s) => (floor ? s.rules[s.buildings.find((b) => b.id === floor.buildingId)?.kind ?? 'office'] : undefined));
  const rulesVersion = rules?.version ?? 0;

  const [tool, setTool] = useState<Tool>('select');
  const [roomUsage, setRoomUsage] = useState<RoomUsage>('office');
  const [draftPoints, setDraftPoints] = useState<Pt[]>([]);
  const [draftCursor, setDraftCursor] = useState<Pt | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [view, setView] = useState<View>({ cx: 20000, cy: 10000, zoom: 0.06 });
  const [drag, setDrag] = useState<DragState>(null);
  const [dragDelta, setDragDelta] = useState<Pt>({ x: 0, y: 0 });
  const [coverageCells, setCoverageCells] = useState<Pt[] | null>(null);
  const [highlight, setHighlight] = useState<Pt | null>(null);
  const [underlayUrl, setUnderlayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在拉的参照线（底图像素坐标），两点齐全后在左栏填真实长度 */
  const [calibDraft, setCalibDraft] = useState<CalibDraft>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 底图 URL 加载
  useEffect(() => {
    let url: string | null = null;
    let revoked = false;
    if (floor?.underlay) {
      getBlob(floor.underlay.key).then((blob) => {
        if (blob && !revoked) {
          url = URL.createObjectURL(blob);
          setUnderlayUrl(url);
        }
      });
    } else {
      setUnderlayUrl(null);
    }
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [floor?.underlay?.key]);

  // 初始视野：按楼层范围适配
  useEffect(() => {
    if (!floor) return;
    const polys = floor.rooms.map((r) => r.polygon);
    if (!polys.length) return;
    const bb = bboxOf(polys);
    const el = svgRef.current;
    const pxW = el ? el.clientWidth : 800;
    const pxH = el ? el.clientHeight : 600;
    const wMm = bb.maxX - bb.minX + 8000;
    const hMm = bb.maxY - bb.minY + 8000;
    setView({
      cx: (bb.minX + bb.maxX) / 2,
      cy: (bb.minY + bb.maxY) / 2,
      zoom: Math.min(pxW / wMm, pxH / hMm),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId, floor?.rooms.length === 0]);

  // 自动校验（防抖）
  useEffect(() => {
    if (!floor || !rules) return;
    setBusy(true);
    const t = setTimeout(() => {
      // 引擎计算放在下一帧，保证「校验中」状态先渲染
      requestAnimationFrame(() => {
        const result = validateFloor(floor, rules);
        setLastValidation(floorId, result);
        setBusy(false);
      });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId, floor?.version, rulesVersion]);

  if (!floor || !rules) {
    return <div className="page">楼层不存在。<Link to="/">返回首页</Link></div>;
  }

  const toMm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const svg = svgRef.current!;
      return mmFromEvent(svg, view, e);
    },
    [view],
  );

  // ---------- 画布事件 ----------

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button === 1 || tool === 'pan' || (tool === 'select' && e.currentTarget === e.target)) {
      const p = toMm(e);
      setDrag({ kind: 'pan', startMm: p, orig: { cx: view.cx, cy: view.cy }, moved: false });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (tool === 'calib-line') {
      // 参照线落点取底图像素坐标（不吸附，要对齐图上墙线/轴网）
      if (!floor.underlay) return;
      // 已落下第一点、等待第二点时，pointerdown 不做事，由 pointerup 收第二点
      if (calibDraft && calibDraft.aPx && !calibDraft.bPx) return;
      const px = mmToPx(toMm(e), floor.underlay);
      setCalibDraft({ aPx: px, bPx: null });
      return;
    }
    if (tool === 'select') {
      setSelected(null);
      return;
    }
  };

  const onRoomDown = (e: React.PointerEvent<SVGGElement>, room: Room) => {
    if (tool !== 'select') return;
    const p = toMm(e);
    setSelected({ type: 'room', id: room.id });
    setDrag({ kind: 'room', id: room.id, startMm: p, orig: room.polygon, moved: false });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onFacilityDown = (e: React.PointerEvent<SVGGElement>, fac: Facility) => {
    if (tool !== 'select') return;
    const p = toMm(e);
    setSelected({ type: 'facility', id: fac.id });
    setDrag({ kind: 'facility', id: fac.id, startMm: p, orig: { x: fac.x, y: fac.y }, moved: false });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toMm(e);
    if (tool === 'room' || tool === 'corridor') setDraftCursor({ x: snap(p.x), y: snap(p.y) });
    if (tool === 'calib-line' && calibDraft && floor.underlay) {
      setCalibDraft({ ...calibDraft, bPx: mmToPx(p, floor.underlay) });
      return;
    }
    if (!drag) return;
    if (drag.kind === 'pan') {
      const o = drag.orig as { cx: number; cy: number };
      const dx = (p.x - drag.startMm.x) * view.zoom;
      const dy = (p.y - drag.startMm.y) * view.zoom;
      setView({ ...view, cx: o.cx - dx / view.zoom, cy: o.cy - dy / view.zoom });
      return;
    }
    const dx = snap(p.x - drag.startMm.x);
    const dy = snap(p.y - drag.startMm.y);
    if (dx !== 0 || dy !== 0) drag.moved = true;
    setDragDelta({ x: dx, y: dy });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    // 参照线第二个落点：完成线段，等待左栏填真实长度
    if (tool === 'calib-line' && calibDraft?.aPx && !drag && floor.underlay) {
      const px = mmToPx(toMm(e), floor.underlay);
      setCalibDraft({ aPx: calibDraft.aPx, bPx: px });
      return;
    }
    if (!drag) {
      // 绘制/放置点击
      const p = toMm(e);
      const sp = { x: snap(p.x), y: snap(p.y) };
      if (tool === 'room' || tool === 'corridor') {
        // 双击起点附近闭合
        if (draftPoints.length >= 3 && Math.hypot(sp.x - draftPoints[0].x, sp.y - draftPoints[0].y) < 600) {
          commitDraft();
          return;
        }
        setDraftPoints([...draftPoints, sp]);
      } else if (tool !== 'select' && tool !== 'pan' && tool !== 'calib-line') {
        addFacility(floorId, tool, sp.x, sp.y);
      }
      return;
    }
    const d = drag;
    const delta = dragDelta;
    setDrag(null);
    setDragDelta({ x: 0, y: 0 });
    if (!d.moved || (delta.x === 0 && delta.y === 0)) {
      if (d.kind === 'pan') return;
      if (d.kind === 'mark') return;
    }
    if (d.kind === 'room' && d.id && (delta.x !== 0 || delta.y !== 0)) {
      moveRoom(floorId, d.id, delta.x, delta.y);
    } else if (d.kind === 'facility' && d.id && (delta.x !== 0 || delta.y !== 0)) {
      const fac = floor.facilities.find((f) => f.id === d.id);
      if (fac) moveFacility(floorId, d.id, fac.x + delta.x, fac.y + delta.y);
    }
  };

  const commitDraft = () => {
    if (draftPoints.length >= 3) {
      addRoom(floorId, draftPoints, tool === 'corridor' ? `走道${floor.rooms.filter((r) => r.usage === 'corridor').length + 1}` : `房间${floor.rooms.length + 1}`, tool === 'corridor' ? 'corridor' : roomUsage);
    }
    setDraftPoints([]);
    setDraftCursor(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (tool === 'calib-line') return; // 参照线的确认在左栏输入框，Enter 不闭合
      commitDraft();
    }
    if (e.key === 'Escape') {
      setDraftPoints([]);
      setDraftCursor(null);
      setCalibDraft(null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      if (selected.type === 'room') deleteRoom(floorId, selected.id);
      else deleteFacility(floorId, selected.id);
      setSelected(null);
    }
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current!;
    setView(wheelZoom(view, e, svg));
  };

  const locate = (pt: Pt | null | undefined, sel?: Selection) => {
    if (pt) {
      setHighlight(pt);
      setView((v) => ({ ...v, cx: pt.x, cy: pt.y }));
      setTimeout(() => setHighlight(null), 2500);
    }
    if (sel) setSelected(sel);
    setTool('select');
  };

  const showCoverage = () => {
    if (coverageCells) {
      setCoverageCells(null);
      return;
    }
    const exts = floor.facilities.filter((f) => f.kind === 'extinguisher').map((f) => ({ x: f.x, y: f.y }));
    const res = computeCoverage(floor.rooms, exts, rules.extinguisherRadiusM, true);
    setCoverageCells(res.cells);
  };

  const importUnderlay = async (file: File) => {
    const { blob, w, h } = await compressImage(file, 1600);
    const key = `underlay/${uid()}`;
    await putBlob(key, blob);
    const polys = floor.rooms.map((r) => r.polygon);
    const bb = polys.length ? bboxOf(polys) : { minX: 0, minY: 0, maxX: 40000, maxY: 30000 };
    const scale = (bb.maxX - bb.minX) / w || 10;
    setUnderlay(floorId, {
      key,
      wPx: w,
      hPx: h,
      offsetX: bb.minX,
      offsetY: bb.minY,
      scaleMmPerPx: scale,
      opacity: 0.5,
      visible: true,
      refLines: [],
      areaCalibs: [],
      // 旧行为：导入新图不动已有毫米坐标；用户可随时切到「跟着重算」
      contentPolicy: 'keep',
      scaleBasis: 'import',
      scaleBasisDetail: `导入估算（${scale.toFixed(1)} mm/px）`,
    });
  };

  /** 确认参照线：存像素线段并立即按全部参照线反算比例（走当前重算策略） */
  const commitCalibLine = (realM: number) => {
    const u = floor.underlay;
    if (!u || !calibDraft?.bPx || !(realM > 0)) return;
    addRefLine(floorId, { a: calibDraft.aPx, b: calibDraft.bPx, realMm: realM * MM_PER_M });
    setCalibDraft(null);
    // addRefLine 与 setUnderlayScale 各自 bump version（两次校验防抖，无副作用）
    const next = scaleFromRefLines([...u.refLines, { id: 'pending', a: calibDraft.aPx, b: calibDraft.bPx!, realMm: realM * MM_PER_M }]);
    if (next) {
      setUnderlayScale(floorId, next, 'reflines', `参照线 ${u.refLines.length + 1} 条反算`);
    }
  };

  /** 按某条参照线当前填写的真实长度重新反算（编辑长度后调用） */
  const reapplyRefLine = (lineId: string) => {
    const u = floor.underlay;
    if (!u) return;
    const next = scaleFromRefLines(u.refLines);
    if (next) setUnderlayScale(floorId, next, 'reflines', `参照线 ${u.refLines.length} 条反算（编辑 ${lineId.slice(-4)}）`);
  };

  /** 采用互校反推比例（面积反校页/醒目横幅的「采用建议比例」） */
  const adoptExpectedScale = (scale: number, basis: Underlay['scaleBasis'], detail: string) => {
    setUnderlayScale(floorId, scale, basis, detail);
  };

  const selRoom: Room | undefined = selected?.type === 'room' ? floor.rooms.find((r) => r.id === selected.id) : undefined;
  const selFac: Facility | undefined = selected?.type === 'facility' ? floor.facilities.find((f) => f.id === selected.id) : undefined;
  const result = floor.lastValidation;

  // 底图双向互校结果（与引擎同一份纯函数，UI 横幅实时反映）
  const underlay = floor.underlay;
  const calib = useMemo(() => {
    if (!underlay) return { checks: [], bad: [], suggested: null as number | null };
    const roomById = new Map(floor.rooms.map((r) => [r.id, r]));
    const checks = scaleChecks(underlay, roomById);
    return { checks, bad: failingScaleChecks(checks), suggested: representativeScale(checks) };
  }, [underlay, floor.rooms]);
  const draftPxLen =
    tool === 'calib-line' && calibDraft?.bPx && underlay ? refLinePxLen({ id: '', a: calibDraft.aPx, b: calibDraft.bPx, realMm: 0 }) : null;

  return (
    <div className="editor" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* 左栏：工具与元素库 */}
      <aside className="panel left">
        <div className="crumb">
          <Link to="/">{building?.name ?? '未命名建筑'}</Link> / {floorLabel(floor.level)} 层
        </div>
        <section>
          <h4>工具</h4>
          <div className="toolgrid">
            <button className={tool === 'select' ? 'on' : ''} onClick={() => { setTool('select'); setDraftPoints([]); }}>选择/移动</button>
            <button className={tool === 'pan' ? 'on' : ''} onClick={() => setTool('pan')}>平移</button>
            <button className={tool === 'room' ? 'on' : ''} onClick={() => setTool('room')}>画房间</button>
            <button className={tool === 'corridor' ? 'on' : ''} onClick={() => setTool('corridor')}>画走道</button>
            <button
              className={tool === 'calib-line' ? 'on' : ''}
              disabled={!floor.underlay}
              title={floor.underlay ? '在底图上拉已知长度的参照线反算比例' : '请先导入底图'}
              onClick={() => { setTool('calib-line'); setDraftPoints([]); setCalibDraft(null); }}
            >
              比例参照线
            </button>
          </div>
          {tool === 'room' && (
            <div className="toolgrid">
              {ROOM_USAGES.map((u) => (
                <button key={u} className={roomUsage === u ? 'on' : ''} onClick={() => setRoomUsage(u)}>
                  <span className="swatch" style={{ background: USAGE_FILLS[u] }} />
                  {USAGE_LABELS[u]}
                </button>
              ))}
            </div>
          )}
          <p className="hint">
            {tool === 'room' || tool === 'corridor'
              ? '点击落点，Enter/双击起点闭合，Esc 取消'
              : tool === 'calib-line'
                ? '在底图上依次点击参照线两端（对齐墙线/轴网），再到左栏填真实长度；Esc 取消'
                : '滚轮缩放，拖动空白处平移'}
          </p>
        </section>
        <section>
          <h4>设施</h4>
          <div className="toolgrid">
            {FAC_KINDS.map((k) => (
              <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(k)}>
                <FacilityGlyph kind={k} s={7} />
                {FACILITY_LABELS[k]}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h4>底图与比例互校</h4>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && importUnderlay(e.target.files[0])} />
          <button onClick={() => fileRef.current?.click()}>导入底图图片</button>
          {floor.underlay && (
            <UnderlayPanel
              floorId={floorId}
              underlay={floor.underlay}
              rooms={floor.rooms}
              tool={tool}
              calibDraft={calibDraft}
              draftPxLen={draftPxLen}
              checks={calib.checks}
              bad={calib.bad}
              suggested={calib.suggested}
              onCommitLine={commitCalibLine}
              onReapplyLine={reapplyRefLine}
              onCancelDraft={() => setCalibDraft(null)}
              onAdoptScale={adoptExpectedScale}
            />
          )}
        </section>
        <section>
          <h4>图例</h4>
          <div className="legend">
            {FAC_KINDS.map((k) => (
              <span key={k} className="legendrow">
                <span className="glyphbox"><FacilityGlyph kind={k} s={6} /></span>
                {FACILITY_LABELS[k]}
              </span>
            ))}
          </div>
        </section>
      </aside>

      {/* 中栏：图纸 */}
      <div className="canvas-wrap">
        <div className="canvas-toolbar">
          <span>{floorLabel(floor.level)} · {floor.rooms.length} 房间 · {floor.facilities.length} 设施</span>
          {underlay && (
            <span className={`basis-badge ${calib.bad.length ? 'bad' : calib.checks.length ? 'ok' : ''}`}>
              比例 {underlay.scaleMmPerPx.toFixed(2)} mm/px · 来源：{SCALE_BASIS_LABELS[underlay.scaleBasis]} ·
              改比例时：{underlay.contentPolicy === 'rescale' ? '已有图形跟着重算' : '已有图形保持原样'}
            </span>
          )}
          <button className={coverageCells ? 'on' : ''} onClick={showCoverage}>
            {coverageCells ? '隐藏未覆盖区域' : '显示未覆盖区域'}
          </button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.3) })) }}>放大</button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.max(0.008, v.zoom / 1.3) })) }}>缩小</button>
          <Link className="btn" to={`/floor/${floorId}/print`}>打印 / 出图</Link>
        </div>
        {underlay && calib.bad.length > 0 && (
          <div className="scale-alert">
            <b>⚠ 底图比例失准（{calib.bad.length} 项互校偏差 &gt; {(SCALE_TOLERANCE * 100).toFixed(0)}%）：</b>
            {calib.bad.map((c) => (
              <span key={`${c.kind}-${c.id}`} className="scale-alert-item">
                {c.name} 反推 {c.expectedScale.toFixed(2)} mm/px（{formatDeviation(c.deviation)}）
              </span>
            ))}
            {calib.suggested && (
              <button
                className="on"
                onClick={() => adoptExpectedScale(calib.suggested!, calib.bad.some((c) => c.kind === 'refline') ? 'reflines' : 'areas', '互校横幅采用建议比例')}
              >
                采用建议比例 {calib.suggested.toFixed(2)} mm/px
              </button>
            )}
            <span className="hint">比例不改，照图描出的面积与疏散距离都会系统性失真，校验已判为不合规。</span>
          </div>
        )}
        <svg
          ref={svgRef}
          className="canvas"
          tabIndex={0}
          viewBox={`${view.cx - 500 / view.zoom} ${view.cy - 400 / view.zoom} ${1000 / view.zoom} ${800 / view.zoom}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={() => { if (tool === 'room' || tool === 'corridor') commitDraft(); }}
        >
          <FloorPlan
            floor={floor}
            view={view}
            svgRef={svgRef}
            underlayUrl={underlayUrl}
            selected={selected}
            drag={drag}
            dragDelta={dragDelta}
            draftPoints={draftPoints}
            draftCursor={draftCursor}
            coverageCells={coverageCells}
            highlight={highlight}
            markPt={null}
            showCalib
            calibDraft={
              underlay && calibDraft
                ? { a: pxToMm(calibDraft.aPx, underlay), b: calibDraft.bPx ? pxToMm(calibDraft.bPx, underlay) : null }
                : null
            }
            onRoomPointerDown={onRoomDown}
            onFacilityPointerDown={onFacilityDown}
          />
        </svg>
      </div>

      {/* 右栏：校验与属性 */}
      <aside className="panel right">
        <ValidationPanel
          floorId={floorId}
          result={result ?? null}
          busy={busy}
          rules={rules}
          onLocate={locate}
        />
        {selRoom && (
          <section>
            <h4>房间属性</h4>
            <label className="row">名称 <input value={selRoom.name} onChange={(e) => updateRoom(floorId, selRoom.id, { name: e.target.value })} /></label>
            <label className="row">用途
              <select value={selRoom.usage} onChange={(e) => updateRoom(floorId, selRoom.id, { usage: e.target.value as RoomUsage })}>
                {Object.entries(USAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="row">人数 <input type="number" min={0} value={selRoom.occupants ?? ''} placeholder="按面积估算" onChange={(e) => updateRoom(floorId, selRoom.id, { occupants: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
            <p className="hint">面积 {selRoom.areaM2.toFixed(1)}㎡（多边形自动计算）</p>
            <button className="danger" onClick={() => { deleteRoom(floorId, selRoom.id); setSelected(null); }}>删除房间</button>
          </section>
        )}
        {selFac && (
          <FacilityInspector floorId={floorId} fac={selFac} onDelete={() => { deleteFacility(floorId, selFac.id); setSelected(null); }} />
        )}
      </aside>
    </div>
  );
}

type CalibDraftType = { aPx: Pt; bPx: Pt | null } | null;

type UnderlayPanelProps = {
  floorId: string;
  underlay: NonNullable<Floor['underlay']>;
  rooms: Room[];
  tool: Tool;
  calibDraft: CalibDraftType;
  draftPxLen: number | null;
  checks: ReturnType<typeof scaleChecks>;
  bad: ReturnType<typeof scaleChecks>;
  suggested: number | null;
  onCommitLine: (realM: number) => void;
  onReapplyLine: (lineId: string) => void;
  onCancelDraft: () => void;
  onAdoptScale: (scale: number, basis: Underlay['scaleBasis'], detail: string) => void;
};

/** 左栏「底图与比例互校」：比例来源、重算策略、参照线正校、面积反校，全部写在明面上 */
function UnderlayPanel({
  floorId, underlay: u, rooms, tool, calibDraft, draftPxLen, checks, bad, suggested,
  onCommitLine, onReapplyLine, onCancelDraft, onAdoptScale,
}: UnderlayPanelProps) {
  const [realM, setRealM] = useState('');
  const [manualScale, setManualScale] = useState(String(u.scaleMmPerPx));
  const [areaRoomId, setAreaRoomId] = useState(rooms[0]?.id ?? '');
  const [areaReal, setAreaReal] = useState('');

  // 比例可能被别处（参照线/横幅）改掉：外部值变化时同步输入框
  useEffect(() => setManualScale(String(u.scaleMmPerPx)), [u.scaleMmPerPx]);
  useEffect(() => {
    if (!rooms.some((r) => r.id === areaRoomId)) setAreaRoomId(rooms[0]?.id ?? '');
  }, [rooms, areaRoomId]);

  const commitManual = () => {
    const v = Number(manualScale);
    if (v > 0 && Math.abs(v - u.scaleMmPerPx) > 1e-9) {
      setUnderlayScale(floorId, v, 'manual', '手工填写');
    } else {
      setManualScale(String(u.scaleMmPerPx));
    }
  };

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const checkByKey = new Map(checks.map((c) => [`${c.kind}-${c.id}`, c]));
  const badKeys = new Set(bad.map((c) => `${c.kind}-${c.id}`));
  const validDraft = !!calibDraft?.bPx && (draftPxLen ?? 0) > 0;
  const draftShownM = validDraft ? (draftPxLen! * u.scaleMmPerPx) / MM_PER_M : null;
  const areaSel = rooms.find((r) => r.id === areaRoomId);
  const areaSuggested = areaSel ? scaleFromRoom(areaSel, Number(areaReal), u.scaleMmPerPx) : null;

  return (
    <div className="stack">
      <label className="row">
        <input
          type="checkbox"
          checked={u.visible}
          onChange={(e) => updateUnderlay(floorId, { visible: e.target.checked })}
        />
        显示底图
      </label>
      <label className="row">
        不透明度
        <input
          type="range" min={0.05} max={1} step={0.05}
          value={u.opacity}
          onChange={(e) => updateUnderlay(floorId, { opacity: Number(e.target.value) })}
        />
      </label>

      {/* 当前比例与来源：写明是哪来的，改比例时已描内容怎么处理 */}
      <div className="scale-box">
        <label className="row">
          比例 (mm/px)
          <input
            type="number" min={0.01} step={0.1} style={{ width: 80 }}
            value={manualScale}
            onChange={(e) => setManualScale(e.target.value)}
            onBlur={commitManual}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>
        <p className="hint">
          当前来源：<b>{SCALE_BASIS_LABELS[u.scaleBasis]}</b>{u.scaleBasisDetail ? `（${u.scaleBasisDetail}）` : ''}
        </p>
        <div className="policy" role="radiogroup" aria-label="改比例时已描内容处理方式">
          <label className="row" title="改比例后，房间多边形与设施点位以底图左上角为不动点跟着缩放，面积/距离按真实比例更新">
            <input
              type="radio" name="content-policy"
              checked={u.contentPolicy === 'rescale'}
              onChange={() => setContentPolicy(floorId, 'rescale')}
            />
            已有图形跟着重算
          </label>
          <label className="row" title="只换底图显示，房间/设施的毫米坐标一律不动（旧行为）">
            <input
              type="radio" name="content-policy"
              checked={u.contentPolicy === 'keep'}
              onChange={() => setContentPolicy(floorId, 'keep')}
            />
            已有图形保持原样
          </label>
        </div>
        <p className="hint">
          当前策略：{u.contentPolicy === 'rescale'
            ? '改比例时房间与设施以底图左上角为不动点重算。'
            : '改比例只动底图；可对当前比例点「立即重算已有图形」。'}
        </p>
        <button
          className="ghost"
          disabled={u.contentPolicy === 'rescale'}
          onClick={() => rescaleFloorContent(floorId, u.scaleMmPerPx)}
          title={u.contentPolicy === 'rescale' ? '当前已是「跟着重算」策略' : '以底图左上角为不动点，把房间与设施重算到当前比例'}
        >
          立即按当前比例重算已有图形
        </button>
      </div>

      {/* 正校：参照线 */}
      <div className="calib-box">
        <h5>① 参照线反算（正校）</h5>
        <p className="hint">
          {tool === 'calib-line'
            ? validDraft
              ? `线段图上长约 ${draftShownM!.toFixed(2)}m，填真实长度后确认`
              : '在底图上依次点击线段两端（不吸附，对齐墙线）'
            : '点上方「比例参照线」工具，在底图上拉一条已知长度的线段。'}
        </p>
        {calibDraft && (
          <div className="stack">
            <label className="row">
              真实长度 (m)
              <input
                type="number" min={0.01} step={0.1} autoFocus
                value={realM}
                onChange={(e) => setRealM(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && Number(realM) > 0) { onCommitLine(Number(realM)); setRealM(''); } }}
              />
            </label>
            <div className="row">
              <button disabled={!validDraft || !(Number(realM) > 0)} onClick={() => { onCommitLine(Number(realM)); setRealM(''); }}>确认并反算比例</button>
              <button className="ghost" onClick={() => { onCancelDraft(); setRealM(''); }}>取消</button>
            </div>
          </div>
        )}
        {u.refLines.map((l) => {
          const c = checkByKey.get(`refline-${l.id}`);
          const isBad = badKeys.has(`refline-${l.id}`);
          const shownM = (refLinePxLen(l) * u.scaleMmPerPx) / MM_PER_M;
          const realMv = l.realMm / MM_PER_M;
          return (
            <RefLineRow
              key={l.id}
              realM={realMv}
              shownM={shownM}
              deviation={c?.deviation ?? null}
              isBad={isBad}
              onCommit={(m) => { updateRefLine(floorId, l.id, { realMm: m * MM_PER_M }); onReapplyLine(l.id); }}
              onDelete={() => deleteRefLine(floorId, l.id)}
            />
          );
        })}
      </div>

      {/* 反校：房间真实面积 */}
      <div className="calib-box">
        <h5>② 房间面积反推（反校）</h5>
        <p className="hint">选一个已描房间、填它的真实面积，反推 mm/px 并与当前比例对比；差 &gt; 3% 即醒目提示。</p>
        {rooms.length === 0 && <p className="hint">先在图上描出房间才能做面积反校。</p>}
        {rooms.length > 0 && (
          <div className="stack">
            <label className="row">
              房间
              <select value={areaRoomId} onChange={(e) => setAreaRoomId(e.target.value)}>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}（图上 {r.areaM2.toFixed(1)}㎡）</option>)}
              </select>
            </label>
            <label className="row">
              真实面积 (㎡)
              <input type="number" min={0.1} step={0.5} value={areaReal} onChange={(e) => setAreaReal(e.target.value)} />
            </label>
            <div className="row">
              <button
                disabled={!(Number(areaReal) > 0)}
                onClick={() => { if (areaRoomId && Number(areaReal) > 0) setAreaCalib(floorId, areaRoomId, Number(areaReal)); }}
              >
                加入反校
              </button>
              {areaSuggested && (
                <button
                  className="ghost"
                  title="按该房间真实面积反推比例并采用（走当前重算策略）"
                  onClick={() => onAdoptScale(areaSuggested, 'areas', `房间「${areaSel?.name ?? ''}」面积反推`)}
                >
                  反推 {areaSuggested.toFixed(2)} 并采用
                </button>
              )}
            </div>
          </div>
        )}
        {u.areaCalibs.map((c0) => {
          const room = roomById.get(c0.roomId);
          if (!room) return null;
          const c = checkByKey.get(`area-${c0.roomId}`);
          const isBad = badKeys.has(`area-${c0.roomId}`);
          const s = scaleFromRoom(room, c0.realM2, u.scaleMmPerPx);
          return (
            <div key={c0.roomId} className={`calibrow ${isBad ? 'bad' : 'ok'}`}>
              <span>
                {room.name}：实 {c0.realM2}㎡ · 图 {room.areaM2.toFixed(1)}㎡
                {c ? ` · 偏差 ${formatDeviation(c.deviation)}` : ''}
                {s ? ` · 应 ${s.toFixed(2)} mm/px` : ''}
              </span>
              <div className="row">
                {isBad && s && (
                  <button className="ghost" onClick={() => onAdoptScale(s, 'areas', `房间「${room.name}」面积反推`)}>采用</button>
                )}
                <button className="ghost" onClick={() => deleteAreaCalib(floorId, c0.roomId)}>删</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 互校汇总 */}
      {checks.length > 0 && (
        <p className={`hint calib-summary ${bad.length ? 'bad' : 'good'}`}>
          {bad.length
            ? `${bad.length}/${checks.length} 项互校偏差超 ±3%，校验不合规`
            : `${checks.length} 项互校均在 ±3% 内，比例可信`}
          {suggested && bad.length > 0 ? `；建议比例 ${suggested.toFixed(2)} mm/px` : ''}
        </p>
      )}
      <button className="ghost" onClick={() => setUnderlay(floorId, undefined)}>移除底图</button>
    </div>
  );
}

/** 已确认参照线行：真实长度只在失焦/回车时提交，避免 rescale 策略下逐键反复变换图形 */
function RefLineRow({
  realM, shownM, deviation, isBad, onCommit, onDelete,
}: {
  realM: number;
  shownM: number;
  deviation: number | null;
  isBad: boolean;
  onCommit: (m: number) => void;
  onDelete: () => void;
}) {
  const [v, setV] = useState(String(realM));
  useEffect(() => setV(String(realM)), [realM]);
  const commit = () => {
    const n = Number(v);
    if (n > 0) onCommit(n);
    else setV(String(realM));
  };
  return (
    <div className={`calibrow ${isBad ? 'bad' : deviation != null ? 'ok' : ''}`}>
      <span>
        实 {realM.toFixed(2)}m · 图 {shownM.toFixed(2)}m
        {deviation != null ? ` · 偏差 ${formatDeviation(deviation)}` : ''}
      </span>
      <div className="row">
        <input
          type="number" min={0.01} step={0.1} value={v}
          style={{ width: 70 }}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        m
        <button className="ghost" onClick={onDelete}>删</button>
      </div>
    </div>
  );
}

function FacilityInspector({ floorId, fac, onDelete }: { floorId: string; fac: Facility; onDelete: () => void }) {
  const [note, setNote] = useState('');
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  const photoInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const urls: Record<number, string> = {};
    Promise.all(
      fac.checks.map(async (c, i) => {
        if (!c.photoKey) return;
        const blob = await getBlob(c.photoKey);
        if (blob) urls[i] = URL.createObjectURL(blob);
      }),
    ).then(() => {
      if (!cancelled) setPhotoUrls(urls);
    });
    return () => {
      cancelled = true;
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [fac.checks]);

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState<'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing'>('ok');

  const submitCheck = async () => {
    let photoKey: string | undefined;
    const file = photoInput.current?.files?.[0];
    if (file) {
      const { blob } = await compressImage(file, 1600);
      photoKey = `photo/${uid()}`;
      await putBlob(photoKey, blob);
    }
    addCheck(floorId, fac.id, { date, status, note: note || undefined, photoKey });
    setNote('');
    if (photoInput.current) photoInput.current.value = '';
  };

  return (
    <section>
      <h4>设施 · {fac.code}</h4>
      <p className="hint">坐标 {(fac.x / 1000).toFixed(1)}m, {(fac.y / 1000).toFixed(1)}m</p>
      {fac.kind === 'extinguisher' && (
        <>
          <label className="row">类型
            <select
              value={fac.spec?.extType ?? 'dry_powder'}
              onChange={(e) => updateFacility(floorId, fac.id, { spec: { ...fac.spec, extType: e.target.value as 'dry_powder' | 'co2' | 'water' } })}
            >
              <option value="dry_powder">干粉</option>
              <option value="co2">二氧化碳</option>
              <option value="water">水基</option>
            </select>
          </label>
          <label className="row">规格 (kg)
            <input
              type="number" min={0}
              value={fac.spec?.weightKg ?? ''}
              onChange={(e) => updateFacility(floorId, fac.id, { spec: { ...fac.spec, weightKg: Number(e.target.value) } })}
            />
          </label>
        </>
      )}
      <h4>检查记录</h4>
      <div className="checks">
        {[...fac.checks]
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((c) => {
            const realIdx = fac.checks.indexOf(c);
            return (
              <div key={realIdx} className="checkrow">
                <span>{c.date}</span>
                <span className={`badge st-${c.status}`}>{c.status}</span>
                {c.note && <span className="hint">{c.note}</span>}
                {photoUrls[realIdx] && <img className="thumb" src={photoUrls[realIdx]} alt="检查照片" />}
                <button className="ghost" onClick={() => deleteCheck(floorId, fac.id, realIdx)}>删</button>
              </div>
            );
          })}
        {!fac.checks.length && <p className="hint">暂无记录</p>}
      </div>
      <div className="stack">
        <label className="row">日期 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="row">状态
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="ok">正常</option>
            <option value="low_pressure">压力不足</option>
            <option value="expired">过期</option>
            <option value="damaged">损坏</option>
            <option value="missing">缺失</option>
          </select>
        </label>
        <label className="row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="row">照片 <input ref={photoInput} type="file" accept="image/*" /></label>
        <button onClick={submitCheck}>登记检查</button>
      </div>
      <button className="danger" onClick={onDelete}>删除设施</button>
    </section>
  );
}
