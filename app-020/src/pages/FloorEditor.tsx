import { useCallback, useEffect, useRef, useState } from 'react';
import type { Facility, Pt, Room, RoomUsage } from '../model';
import { USAGE_LABELS, FACILITY_LABELS } from '../model';
import { addRoom, addFacility, deleteFacility, deleteRoom, moveFacility, moveRoom, updateRoom, updateFacility, setUnderlay, applyUnderlayScale, setLastValidation, useStore, addCheck, deleteCheck } from '../store/store';
import { floorLabel } from '../store/id';
import { getBlob, putBlob, compressImage } from '../store/db';
import { uid } from '../store/id';
import { bboxOf } from '../lib/geometry';
import { SCALE_WARN_THRESHOLD, scaleDeviation, scaleFromArea, scaleFromRefLine } from '../lib/scale';
import { computeCoverage, validateFloor } from '../lib/engine';
import { FloorPlan, mmFromEvent, wheelZoom, type DragState, type Selection, type Tool, type View } from '../components/FloorPlan';
import { FacilityGlyph, USAGE_FILLS } from '../components/symbols';

import { ValidationPanel } from '../components/ValidationPanel';
import { Link } from '../router';

const SNAP = 100; // 绘制/拖动吸附 0.1m
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const ROOM_USAGES: RoomUsage[] = ['office', 'retail', 'storage', 'ward', 'other'];
const FAC_KINDS = ['extinguisher', 'hydrant', 'exit_sign', 'emergency_light', 'exit', 'sprinkler'] as const;

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
  // 参照线绘制：第一个端点 + 跟随光标的预览点（不吸附，尽量对准底图特征）
  const [refA, setRefA] = useState<Pt | null>(null);
  const [refCursor, setRefCursor] = useState<Pt | null>(null);
  // 比例输入框为提交式（blur/Enter 生效）：跟随重算模式下，输入中间态不能触发几何缩放
  const [scaleInput, setScaleInput] = useState<string | null>(null);
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

  // 自动校验（防抖）。底图校核字段（比例/参照线/面积校核）也参与触发：
  // setUnderlay 不加楼层版本，但校核结果会影响 UNDERLAY_SCALE_MISMATCH 校验项
  const u = floor?.underlay;
  const calibKey = `${u?.scaleMmPerPx ?? ''}|${JSON.stringify(u?.refLine ?? null)}|${JSON.stringify(u?.areaCheck ?? null)}`;
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
  }, [floorId, floor?.version, rulesVersion, calibKey]);

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
    if (tool === 'scale_ref' && refA) setRefCursor(p);
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
    if (!drag) {
      // 绘制/放置点击
      const p = toMm(e);
      const sp = { x: snap(p.x), y: snap(p.y) };
      if (tool === 'scale_ref') {
        // pointerleave 也会进这个 handler，画参照线时不响应（避免误落点）
        if (e.type !== 'pointerup') return;
        if (!refA) {
          setRefA(p);
          setRefCursor(p);
        } else {
          // 两端点太近视为误触，不生成参照线
          if (Math.hypot(p.x - refA.x, p.y - refA.y) > 50 && floor.underlay) {
            setUnderlay(floorId, {
              ...floor.underlay,
              refLine: { ax: refA.x, ay: refA.y, bx: p.x, by: p.y, realLengthM: floor.underlay.refLine?.realLengthM ?? 0 },
            });
          }
          setRefA(null);
          setRefCursor(null);
          setTool('select');
        }
        return;
      }
      if (tool === 'room' || tool === 'corridor') {
        // 双击起点附近闭合
        if (draftPoints.length >= 3 && Math.hypot(sp.x - draftPoints[0].x, sp.y - draftPoints[0].y) < 600) {
          commitDraft();
          return;
        }
        setDraftPoints([...draftPoints, sp]);
      } else if (tool !== 'select' && tool !== 'pan') {
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
    if (e.key === 'Enter') commitDraft();
    if (e.key === 'Escape') {
      setDraftPoints([]);
      setDraftCursor(null);
      setRefA(null);
      setRefCursor(null);
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
      rescalePolicy: 'keep',
    });
  };

  // ---------- 底图比例校核（双向） ----------
  const underlay = floor.underlay;
  const policy = underlay?.rescalePolicy ?? 'keep';
  const refLine = underlay?.refLine;
  const refLineMm = refLine ? Math.hypot(refLine.bx - refLine.ax, refLine.by - refLine.ay) : 0;
  // 参照线反算 / 面积反推：两个相互独立的比例来源
  const lineScale = underlay && refLine
    ? scaleFromRefLine({ x: refLine.ax, y: refLine.ay }, { x: refLine.bx, y: refLine.by }, refLine.realLengthM, underlay.scaleMmPerPx)
    : null;
  const acRoom = underlay?.areaCheck ? floor.rooms.find((r) => r.id === underlay.areaCheck!.roomId) : undefined;
  const areaScale = underlay?.areaCheck && acRoom
    ? scaleFromArea(acRoom.areaM2, underlay.areaCheck.realAreaM2, underlay.scaleMmPerPx)
    : null;
  const crossDev = lineScale != null && areaScale != null ? scaleDeviation(lineScale, areaScale) : null;
  const pctText = (d: number) => `${(d * 100).toFixed(1)}%`;
  // 反算应用后比例可能是长浮点，显示时收拢到 4 位有效小数
  const fmtScale = (v: number) => String(Number(v.toFixed(4)));

  const commitScaleInput = () => {
    if (scaleInput == null || !underlay) return;
    const v = Number(scaleInput);
    if (Number.isFinite(v) && v > 0) applyUnderlayScale(floorId, v);
    setScaleInput(null);
  };

  const patchUnderlay = (patch: Partial<NonNullable<typeof underlay>>) => {
    if (underlay) setUnderlay(floorId, { ...underlay, ...patch });
  };

  const selRoom: Room | undefined = selected?.type === 'room' ? floor.rooms.find((r) => r.id === selected.id) : undefined;
  const selFac: Facility | undefined = selected?.type === 'facility' ? floor.facilities.find((f) => f.id === selected.id) : undefined;
  const result = floor.lastValidation;

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
              : tool === 'scale_ref'
                ? '在底图上点击已知长度物体的两个端点，Esc 取消'
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
          <h4>底图</h4>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && importUnderlay(e.target.files[0])} />
          <button onClick={() => fileRef.current?.click()}>导入底图图片</button>
          {underlay && (
            <div className="stack">
              <label className="row">
                <input
                  type="checkbox"
                  checked={underlay.visible}
                  onChange={(e) => patchUnderlay({ visible: e.target.checked })}
                />
                显示底图
              </label>
              <label className="row">
                不透明度
                <input
                  type="range" min={0.05} max={1} step={0.05}
                  value={underlay.opacity}
                  onChange={(e) => patchUnderlay({ opacity: Number(e.target.value) })}
                />
              </label>
              <label className="row">
                比例 (mm/px)
                <input
                  type="number" min={0.1} step={0.1} style={{ width: 70 }}
                  value={scaleInput ?? fmtScale(underlay.scaleMmPerPx)}
                  onFocus={() => setScaleInput(fmtScale(underlay.scaleMmPerPx))}
                  onChange={(e) => setScaleInput(e.target.value)}
                  onBlur={commitScaleInput}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitScaleInput(); }}
                />
              </label>
              <span className="row">改比例时已有图形：</span>
              <label className="row">
                <input type="radio" name="rescalePolicy" checked={policy === 'keep'} onChange={() => patchUnderlay({ rescalePolicy: 'keep' })} />
                保持原样（仅底图缩放）
              </label>
              <label className="row">
                <input type="radio" name="rescalePolicy" checked={policy === 'follow'} onChange={() => patchUnderlay({ rescalePolicy: 'follow' })} />
                跟着重算（图形随底图缩放）
              </label>
              <p className="hint">
                当前：{policy === 'follow'
                  ? '跟着重算 —— 修改比例会同步缩放全部房间、设施坐标，面积与疏散距离随之更新'
                  : '保持原样 —— 修改比例只改变底图显示，已描好的房间与设施不动'}
              </p>

              <div className="calib">
                <h5>比例校核（双向互校）</h5>
                <div className="calibrow">
                  <button
                    className={tool === 'scale_ref' ? 'on' : ''}
                    onClick={() => { setTool('scale_ref'); setRefA(null); setRefCursor(null); setDraftPoints([]); }}
                  >
                    {refLine ? '重画参照线' : '画参照线'}
                  </button>
                  {refLine && (
                    <button className="ghost" onClick={() => patchUnderlay({ refLine: undefined })}>清除</button>
                  )}
                </div>
                {refLine && (
                  <>
                    <label className="row">
                      参照线真实长度 (m)
                      <input
                        type="number" min={0} step={0.1} style={{ width: 70 }}
                        value={refLine.realLengthM || ''}
                        placeholder="如 10"
                        onChange={(e) => patchUnderlay({ refLine: { ...refLine, realLengthM: Number(e.target.value) } })}
                      />
                    </label>
                    <p className="hint">图上量得 {(refLineMm / 1000).toFixed(2)}m</p>
                    {lineScale != null && underlay && (
                      <p className={`calibline ${scaleDeviation(lineScale, underlay.scaleMmPerPx) > SCALE_WARN_THRESHOLD ? 'bad' : 'good'}`}>
                        反算 {lineScale.toFixed(2)} mm/px（与当前相差 {pctText(scaleDeviation(lineScale, underlay.scaleMmPerPx))}）
                        <button onClick={() => applyUnderlayScale(floorId, lineScale)}>应用</button>
                      </p>
                    )}
                  </>
                )}
                <div className="calibrow">
                  <select
                    value={underlay.areaCheck?.roomId ?? ''}
                    onChange={(e) => {
                      const roomId = e.target.value;
                      patchUnderlay({ areaCheck: roomId ? { roomId, realAreaM2: underlay.areaCheck?.realAreaM2 ?? 0 } : undefined });
                    }}
                  >
                    <option value="">面积校核：选房间…</option>
                    {floor.rooms.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}（描出 {r.areaM2.toFixed(1)}㎡）</option>
                    ))}
                  </select>
                </div>
                {underlay.areaCheck && (
                  acRoom ? (
                    <>
                      <label className="row">
                        「{acRoom.name}」真实面积 (㎡)
                        <input
                          type="number" min={0} step={0.5} style={{ width: 70 }}
                          value={underlay.areaCheck.realAreaM2 || ''}
                          placeholder="如图纸标注"
                          onChange={(e) => patchUnderlay({ areaCheck: { ...underlay.areaCheck!, realAreaM2: Number(e.target.value) } })}
                        />
                      </label>
                      {areaScale != null && (
                        <p className={`calibline ${scaleDeviation(areaScale, underlay.scaleMmPerPx) > SCALE_WARN_THRESHOLD ? 'bad' : 'good'}`}>
                          反推 {areaScale.toFixed(2)} mm/px（与当前相差 {pctText(scaleDeviation(areaScale, underlay.scaleMmPerPx))}）
                          <button onClick={() => applyUnderlayScale(floorId, areaScale)}>应用</button>
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="hint">所选房间已删除，请重新选择</p>
                  )
                )}
                {crossDev != null && lineScale != null && areaScale != null && (
                  crossDev > SCALE_WARN_THRESHOLD ? (
                    <p className="calib-warn">
                      ⚠ 两种校核互相矛盾：参照线 {lineScale.toFixed(2)} 与面积反推 {areaScale.toFixed(2)} mm/px 相差 {pctText(crossDev)}（&gt;3%）。
                      面积与疏散距离可能整体偏差，请复核参照长度与房间面积。
                    </p>
                  ) : (
                    <p className="hint good">✔ 两种校核一致（相差 {pctText(crossDev)}，≤3%）</p>
                  )
                )}
              </div>
              <button className="ghost" onClick={() => { if (floor.underlay) setUnderlay(floorId, undefined); }}>移除底图</button>
            </div>
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
            <span className="hint">
              底图 {fmtScale(underlay.scaleMmPerPx)} mm/px · 改比例时图形{policy === 'follow' ? '跟着重算' : '保持原样'}
            </span>
          )}
          <button className={coverageCells ? 'on' : ''} onClick={showCoverage}>
            {coverageCells ? '隐藏未覆盖区域' : '显示未覆盖区域'}
          </button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.3) })) }}>放大</button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.max(0.008, v.zoom / 1.3) })) }}>缩小</button>
          <Link className="btn" to={`/floor/${floorId}/print`}>打印 / 出图</Link>
        </div>
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
            onRoomPointerDown={onRoomDown}
            onFacilityPointerDown={onFacilityDown}
          />
          {/* 比例校核参照线：已提交的 + 绘制中的预览 */}
          {refLine && (
            <g pointerEvents="none">
              <line
                x1={refLine.ax} y1={refLine.ay} x2={refLine.bx} y2={refLine.by}
                stroke="#d81b60" strokeWidth={2.5} vectorEffect="non-scaling-stroke"
              />
              <circle cx={refLine.ax} cy={refLine.ay} r={300} fill="#d81b60" />
              <circle cx={refLine.bx} cy={refLine.by} r={300} fill="#d81b60" />
              <text
                x={(refLine.ax + refLine.bx) / 2}
                y={(refLine.ay + refLine.by) / 2 - 500}
                textAnchor="middle" fontSize={380} fill="#d81b60"
                style={{ userSelect: 'none' }}
              >
                参照线 {refLine.realLengthM > 0 ? `${refLine.realLengthM}m` : '（待填真实长度）'}
              </text>
            </g>
          )}
          {tool === 'scale_ref' && refA && (
            <g pointerEvents="none">
              <circle cx={refA.x} cy={refA.y} r={300} fill="#d81b60" />
              {refCursor && (
                <line
                  x1={refA.x} y1={refA.y} x2={refCursor.x} y2={refCursor.y}
                  stroke="#d81b60" strokeWidth={2} strokeDasharray="8 6" vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          )}
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
