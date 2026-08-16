"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  cloneEdit, createInitialEdit, DEFAULT_FILTERS, DEFAULT_TRANSFORM, dimensionsForLongEdge, EditState, estimateBytes,
  exportEdited, formatBytes, FULL_CROP, loadImageFile, outputFilename, renderCanvas, SourceImage,
} from "./image-utils";

type Tool = "crop" | "resize" | "brightness" | "effects" | "transform" | null;
type CropRatio = "free" | "original" | "1:1" | "4:3" | "3:2" | "16:9" | "9:16";
type Preset = { name: string; longEdge: number; filters: EditState["filters"]; transform: EditState["transform"]; output: EditState["output"] };
type Toast = { text: string; tone?: "ok" | "warn" } | null;

const RESOLUTIONS = [
  ["オリジナル", 0], ["QUXGA", 3200], ["QXGA", 2048], ["UXGA", 1600], ["推奨", 1200],
  ["XGA", 1024], ["SVGA", 800], ["VGA", 640], ["QVGA", 320],
] as const;
const RATIO_VALUES: Record<CropRatio, number | null> = { free: null, original: 0, "1:1": 1, "4:3": 4 / 3, "3:2": 3 / 2, "16:9": 16 / 9, "9:16": 9 / 16 };
const RECENT_KEY = "snapcanvas-recent-v1";
const PRESETS_KEY = "snapcanvas-presets-v1";
const COPIED_KEY = "snapcanvas-copied-settings-v1";

function qualityName(quality: number) {
  if (quality >= 0.88) return "高画質";
  if (quality >= 0.68) return "標準";
  return "軽量";
}

export default function Home() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [history, setHistory] = useState<EditState[]>([]);
  const [future, setFuture] = useState<EditState[]>([]);
  const [tool, setTool] = useState<Tool>(null);
  const [cropRatio, setCropRatio] = useState<CropRatio>("free");
  const [draftCrop, setDraftCrop] = useState({ ...FULL_CROP });
  const [comparing, setComparing] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [estimate, setEstimate] = useState(0);
  const [estimating, setEstimating] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; started: number } | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [customTarget, setCustomTarget] = useState(750);
  const [previewAspect, setPreviewAspect] = useState(1);

  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<EditState | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);
  const transientRef = useRef<EditState | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBatchRef = useRef(false);
  const gestureRef = useRef<{
    baseline: EditState | null;
    points: Map<number, { x: number; y: number }>;
    last: { x: number; y: number } | null;
    initialDistance: number;
    initialAngle: number;
    initialTransform: EditState["transform"] | null;
    moved: boolean;
  }>({ baseline: null, points: new Map(), last: null, initialDistance: 0, initialAngle: 0, initialTransform: null, moved: false });
  const cropDragRef = useRef<{ kind: string; x: number; y: number; start: typeof draftCrop; bounds: DOMRect } | null>(null);

  useEffect(() => { editRef.current = edit; }, [edit]);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => {
    try { setPresets(JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]")); } catch { setPresets([]); }
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => () => { if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url); }, []);

  const showToast = useCallback((text: string, tone: "ok" | "warn" = "ok") => {
    setToast({ text, tone });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const openFiles = useCallback(async (selected: File[]) => {
    const images = selected.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setBusy(true);
    try {
      const loaded = await loadImageFile(images[0]);
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
      let recent: Partial<EditState["output"]> = {};
      try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}").output || {}; } catch { /* defaults */ }
      const initial = createInitialEdit(loaded.width, loaded.height, recent);
      setSource(loaded);
      setFiles(images);
      setEdit(initial);
      setHistory([]);
      setFuture([]);
      setDraftCrop({ ...FULL_CROP });
      setTool(null);
      setSaveOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "画像を開けませんでした", "warn");
    } finally { setBusy(false); }
  }, [showToast]);

  const applyEdit = useCallback((next: EditState | ((current: EditState) => EditState)) => {
    const current = editRef.current;
    if (!current) return;
    setHistory((items) => [...items, cloneEdit(current)].slice(-40));
    setFuture([]);
    const value = typeof next === "function" ? next(cloneEdit(current)) : next;
    setEdit(value);
  }, []);

  const beginTransient = useCallback(() => {
    if (editRef.current && !transientRef.current) transientRef.current = cloneEdit(editRef.current);
  }, []);
  const endTransient = useCallback(() => {
    if (!transientRef.current || !editRef.current) return;
    const baseline = transientRef.current;
    transientRef.current = null;
    if (JSON.stringify(baseline) !== JSON.stringify(editRef.current)) {
      setHistory((items) => [...items, baseline].slice(-40));
      setFuture([]);
    }
  }, []);

  const undo = useCallback(() => {
    const current = editRef.current;
    if (!current) return;
    setHistory((items) => {
      const previous = items.at(-1);
      if (!previous) return items;
      setFuture((redos) => [cloneEdit(current), ...redos].slice(0, 40));
      setEdit(cloneEdit(previous));
      return items.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    const current = editRef.current;
    if (!current) return;
    setFuture((items) => {
      const next = items[0];
      if (!next) return items;
      setHistory((undos) => [...undos, cloneEdit(current)].slice(-40));
      setEdit(cloneEdit(next));
      return items.slice(1);
    });
  }, []);

  useEffect(() => {
    if (!source || !edit || !canvasRef.current) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const cropEditing = tool === "crop";
      const drawState = cropEditing
        ? { ...cloneEdit(edit), crop: { ...FULL_CROP }, outputWidth: source.width, outputHeight: source.height }
        : edit;
      const rendered = renderCanvas(source, drawState, { before: comparing, maxEdge: 1400 });
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      setPreviewAspect(rendered.width / rendered.height);
      canvas.getContext("2d")?.drawImage(rendered, 0, 0);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [source, edit, comparing, tool]);

  useEffect(() => {
    if (!source || !edit || !saveOpen) return;
    setEstimating(true);
    const timer = window.setTimeout(() => {
      estimateBytes(source, edit).then(setEstimate).catch(() => setEstimate(0)).finally(() => setEstimating(false));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [source, edit, saveOpen]);

  useEffect(() => {
    if (!edit) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify({ output: edit.output, cropRatio })); } catch { /* private mode */ }
  }, [edit?.output, cropRatio]);

  const resetTransform = () => applyEdit((current) => ({ ...current, transform: { ...DEFAULT_TRANSFORM } }));
  const resetAll = () => {
    if (!source || !edit) return;
    applyEdit(createInitialEdit(source.width, source.height, edit.output));
    setDraftCrop({ ...FULL_CROP });
    setMoreOpen(false);
    showToast("読み込み直後の状態に戻しました");
  };

  const switchTool = (next: Tool) => {
    if (next === "crop" && edit) setDraftCrop({ ...edit.crop });
    setTool((current) => current === next ? null : next);
  };

  const setResolution = (longEdge: number) => {
    if (!source || !edit) return;
    const aspect = (source.width * edit.crop.w) / (source.height * edit.crop.h);
    const dims = longEdge === 0
      ? { width: Math.max(1, Math.round(source.width * edit.crop.w)), height: Math.max(1, Math.round(source.height * edit.crop.h)) }
      : dimensionsForLongEdge(longEdge, aspect);
    applyEdit((current) => ({ ...current, outputWidth: dims.width, outputHeight: dims.height }));
  };

  const setCropRatioPreset = (ratio: CropRatio) => {
    if (!source) return;
    setCropRatio(ratio);
    let value = RATIO_VALUES[ratio];
    if (value === 0) value = source.width / source.height;
    if (!value) return;
    const sourceAspect = source.width / source.height;
    let w = 0.9;
    let h = 0.9;
    if (value > sourceAspect) h = (w * sourceAspect) / value;
    else w = (h * value) / sourceAspect;
    setDraftCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  const applyCrop = () => {
    if (!source) return;
    applyEdit((current) => ({
      ...current,
      crop: { ...draftCrop },
      outputWidth: Math.max(1, Math.round(source.width * draftCrop.w)),
      outputHeight: Math.max(1, Math.round(source.height * draftCrop.h)),
      transform: { ...DEFAULT_TRANSFORM },
    }));
    setTool(null);
    showToast("画像データのトリミングを反映しました");
  };

  const onCropPointerDown = (kind: string, event: React.PointerEvent<HTMLButtonElement>) => {
    const bounds = canvasWrapRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = { kind, x: event.clientX, y: event.clientY, start: { ...draftCrop }, bounds };
  };
  const onCropPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = cropDragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.x) / drag.bounds.width;
    const dy = (event.clientY - drag.y) / drag.bounds.height;
    const next = { ...drag.start };
    if (drag.kind.includes("l")) { next.x = Math.min(drag.start.x + drag.start.w - 0.06, Math.max(0, drag.start.x + dx)); next.w = drag.start.w + drag.start.x - next.x; }
    if (drag.kind.includes("r")) next.w = Math.min(1 - drag.start.x, Math.max(0.06, drag.start.w + dx));
    if (drag.kind.includes("t")) { next.y = Math.min(drag.start.y + drag.start.h - 0.06, Math.max(0, drag.start.y + dy)); next.h = drag.start.h + drag.start.y - next.y; }
    if (drag.kind.includes("b")) next.h = Math.min(1 - drag.start.y, Math.max(0.06, drag.start.h + dy));
    setDraftCrop(next);
  };

  const gestureDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const gesture = gestureRef.current;
    gesture.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!gesture.baseline) gesture.baseline = cloneEdit(editRef.current);
    gesture.moved = false;
    if (gesture.points.size === 1) {
      gesture.last = { x: event.clientX, y: event.clientY };
      longPressRef.current = setTimeout(() => setComparing(true), 480);
    } else if (gesture.points.size === 2) {
      if (longPressRef.current) clearTimeout(longPressRef.current);
      const [a, b] = [...gesture.points.values()];
      gesture.initialDistance = Math.hypot(b.x - a.x, b.y - a.y);
      gesture.initialAngle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      gesture.initialTransform = { ...editRef.current.transform };
      gesture.last = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  };
  const gestureMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture.points.has(event.pointerId) || !editRef.current) return;
    const previousPoint = gesture.points.get(event.pointerId)!;
    gesture.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - previousPoint.x, event.clientY - previousPoint.y) > 3) gesture.moved = true;
    if (gesture.moved && longPressRef.current) clearTimeout(longPressRef.current);
    const bounds = event.currentTarget.getBoundingClientRect();
    if (gesture.points.size === 1 && gesture.last) {
      const dx = (event.clientX - gesture.last.x) / bounds.width;
      const dy = (event.clientY - gesture.last.y) / bounds.height;
      gesture.last = { x: event.clientX, y: event.clientY };
      setEdit((current) => current ? ({ ...current, transform: { ...current.transform, x: current.transform.x + dx, y: current.transform.y + dy } }) : current);
    } else if (gesture.points.size >= 2 && gesture.initialTransform) {
      const [a, b] = [...gesture.points.values()];
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const initial = gesture.initialTransform;
      setEdit((current) => current ? ({ ...current, transform: {
        ...current.transform,
        scale: Math.max(0.1, Math.min(8, initial.scale * (distance / Math.max(1, gesture.initialDistance)))),
        rotation: initial.rotation + angle - gesture.initialAngle,
        x: initial.x + (center.x - (gesture.last?.x ?? center.x)) / bounds.width,
        y: initial.y + (center.y - (gesture.last?.y ?? center.y)) / bounds.height,
      } }) : current);
    }
  };
  const gestureUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    gesture.points.delete(event.pointerId);
    if (longPressRef.current) clearTimeout(longPressRef.current);
    setComparing(false);
    if (gesture.points.size === 0) {
      if (gesture.moved && gesture.baseline && editRef.current && JSON.stringify(gesture.baseline) !== JSON.stringify(editRef.current)) {
        setHistory((items) => [...items, gesture.baseline!].slice(-40));
        setFuture([]);
      }
      gesture.baseline = null; gesture.last = null; gesture.initialTransform = null; gesture.moved = false;
    } else {
      const point = [...gesture.points.values()][0];
      gesture.last = point;
      gesture.initialTransform = editRef.current ? { ...editRef.current.transform } : null;
    }
  };

  const exportCurrent = useCallback(async () => {
    if (!source || !edit) throw new Error("画像がありません");
    return exportEdited(source, edit);
  }, [source, edit]);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const runExport = async (mode: "copy" | "download" | "share" | "photos") => {
    if (!source || !edit) return;
    setBusy(true);
    try {
      if (mode === "copy") {
        const pngEdit = { ...cloneEdit(edit), output: { ...edit.output, format: "image/png" as const, targetBytes: 0 } };
        const result = await exportEdited(source, pngEdit);
        if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("このブラウザでは画像コピーを利用できません");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": result.blob })]);
        showToast("画像をコピーしました。Goodnotesへ貼り付けできます");
        return;
      }
      const result = await exportCurrent();
      const filename = outputFilename(source.file.name, edit);
      const file = new File([result.blob], filename, { type: edit.output.format });
      if (!result.targetMet) showToast("指定容量を達成できませんでした", "warn");
      if (mode === "share" || mode === "photos") {
        if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
          await navigator.share({ files: [file], title: filename });
          showToast(mode === "photos" ? "共有画面から「画像を保存」を選べます" : "共有しました");
        } else {
          downloadBlob(result.blob, filename);
          showToast("ファイルとして保存しました");
        }
      } else {
        downloadBlob(result.blob, filename);
        showToast("ファイルとして保存しました");
      }
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") showToast(error instanceof Error ? error.message : "書き出しに失敗しました", "warn");
    } finally { setBusy(false); }
  };

  const copySettings = () => {
    if (!edit) return;
    const payload = { longEdge: Math.max(edit.outputWidth, edit.outputHeight), filters: edit.filters, transform: edit.transform, output: edit.output };
    localStorage.setItem(COPIED_KEY, JSON.stringify(payload));
    showToast("編集設定をコピーしました");
  };
  const pasteSettings = () => {
    if (!edit || !source) return;
    try {
      const payload = JSON.parse(localStorage.getItem(COPIED_KEY) || "null") as Omit<Preset, "name"> | null;
      if (!payload) throw new Error();
      const aspect = (source.width * edit.crop.w) / (source.height * edit.crop.h);
      const dims = dimensionsForLongEdge(payload.longEdge, aspect);
      applyEdit((current) => ({ ...current, outputWidth: dims.width, outputHeight: dims.height, filters: payload.filters, transform: payload.transform, output: payload.output }));
      setMoreOpen(false); showToast("編集設定を貼り付けました");
    } catch { showToast("コピー済みの設定がありません", "warn"); }
  };
  const savePreset = () => {
    if (!edit || !presetName.trim()) return;
    const next = [...presets, { name: presetName.trim(), longEdge: Math.max(edit.outputWidth, edit.outputHeight), filters: edit.filters, transform: edit.transform, output: edit.output }].slice(-10);
    setPresets(next); localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); setPresetName(""); showToast("プリセットを保存しました");
  };
  const applyPreset = (preset: Preset) => {
    if (!source || !edit) return;
    const aspect = (source.width * edit.crop.w) / (source.height * edit.crop.h);
    const dims = dimensionsForLongEdge(preset.longEdge, aspect);
    applyEdit((current) => ({ ...current, outputWidth: dims.width, outputHeight: dims.height, filters: preset.filters, transform: preset.transform, output: preset.output }));
    setMoreOpen(false); showToast(`${preset.name}を適用しました`);
  };

  const runBatch = async () => {
    if (!edit || files.length < 2) return;
    setBusy(true); cancelBatchRef.current = false; setBatchProgress({ current: 0, total: files.length, started: Date.now() });
    const outputs: File[] = [];
    const targetLongEdge = Math.max(edit.outputWidth, edit.outputHeight);
    const batchStarted = Date.now();
    try {
      for (let index = 0; index < files.length; index += 1) {
        if (cancelBatchRef.current) break;
        setBatchProgress({ current: index + 1, total: files.length, started: batchStarted });
        const item = await loadImageFile(files[index]);
        const dims = dimensionsForLongEdge(targetLongEdge, item.width / item.height);
        const batchEdit = { ...cloneEdit(edit), crop: { ...FULL_CROP }, outputWidth: dims.width, outputHeight: dims.height, transform: { ...DEFAULT_TRANSFORM } };
        const result = await exportEdited(item, batchEdit);
        outputs.push(new File([result.blob], outputFilename(files[index].name, batchEdit, index), { type: batchEdit.output.format }));
        URL.revokeObjectURL(item.url);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (outputs.length && navigator.share && (!navigator.canShare || navigator.canShare({ files: outputs }))) {
        await navigator.share({ files: outputs, title: `SnapCanvas ${outputs.length}枚` });
      } else outputs.forEach((file) => downloadBlob(file, file.name));
      showToast(cancelBatchRef.current ? `${outputs.length}枚で中止しました` : `${outputs.length}枚を順番どおり処理しました`);
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") showToast(error instanceof Error ? error.message : "一括処理に失敗しました", "warn");
    } finally { setBusy(false); setBatchProgress(null); }
  };

  const elapsedLabel = batchProgress && batchProgress.current > 0
    ? `${Math.max(0, Math.round(((Date.now() - batchProgress.started) / batchProgress.current) * (batchProgress.total - batchProgress.current) / 1000))}秒`
    : "計算中";

  if (!source || !edit) {
    return (
      <main className="welcome">
        <section className="welcome-card">
          <div className="brand-mark" aria-hidden="true">S</div>
          <p className="eyebrow">完全オフライン画像編集</p>
          <h1>SnapCanvas</h1>
          <p className="welcome-copy">iPadの画像を、指だけですばやく整える。</p>
          <button className="primary-action" onClick={() => photoInput.current?.click()} disabled={busy}>
            <span>写真を選ぶ</span><small>複数選択にも対応</small>
          </button>
          <button className="secondary-action" onClick={() => fileInput.current?.click()} disabled={busy}>ファイルから選ぶ</button>
          <input ref={photoInput} hidden type="file" accept="image/*" multiple onChange={(event) => void openFiles(Array.from(event.target.files || []))} />
          <input ref={fileInput} hidden type="file" accept="image/*" multiple onChange={(event) => void openFiles(Array.from(event.target.files || []))} />
          <p className="privacy-note"><span className="privacy-dot" />画像は端末の外へ送信されません</p>
          <div className="offline-badge">通信・広告・アカウントなし</div>
        </section>
        {busy && <div className="loading-overlay"><span className="spinner" />画像を準備中…</div>}
      </main>
    );
  }

  const sourceCropAspect = (source.width * edit.crop.w) / (source.height * edit.crop.h);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <button className="icon-button back-button" aria-label="ホームへ戻る" onClick={() => { if (source) URL.revokeObjectURL(source.url); setSource(null); setEdit(null); }}>‹</button>
        <div className="size-pill"><small>画像の実寸</small><strong>{edit.outputWidth.toLocaleString()} × {edit.outputHeight.toLocaleString()} px</strong></div>
        <div className="top-actions">
          <button className="icon-button" aria-label="元に戻す" disabled={!history.length} onClick={undo}>↶</button>
          <button className="icon-button" aria-label="やり直す" disabled={!future.length} onClick={redo}>↷</button>
          <button className="icon-button" aria-label="ヘルプ" onClick={() => setHelpOpen(true)}>?</button>
          <button className="icon-button more-button" aria-label="その他" onClick={() => setMoreOpen(true)}>•••</button>
          <button className="done-button" onClick={() => setSaveOpen(true)}>完了</button>
        </div>
      </header>

      <section className={`workspace ${tool ? "panel-visible" : ""}`}>
        <div className="stage">
          <div ref={canvasWrapRef} className="canvas-wrap" style={{ aspectRatio: String(previewAspect), "--canvas-ratio": String(previewAspect) } as CSSProperties}>
            <canvas
              ref={canvasRef}
              aria-label="画像編集キャンバス"
              onPointerDown={gestureDown}
              onPointerMove={gestureMove}
              onPointerUp={gestureUp}
              onPointerCancel={gestureUp}
              onDoubleClick={resetTransform}
            />
            {tool === "crop" && (
              <div className="crop-layer" aria-label="トリミング範囲">
                <div className="crop-shade top" style={{ height: `${draftCrop.y * 100}%` }} />
                <div className="crop-shade bottom" style={{ top: `${(draftCrop.y + draftCrop.h) * 100}%` }} />
                <div className="crop-shade left" style={{ top: `${draftCrop.y * 100}%`, width: `${draftCrop.x * 100}%`, height: `${draftCrop.h * 100}%` }} />
                <div className="crop-shade right" style={{ top: `${draftCrop.y * 100}%`, left: `${(draftCrop.x + draftCrop.w) * 100}%`, height: `${draftCrop.h * 100}%` }} />
                <div className="crop-box" style={{ left: `${draftCrop.x * 100}%`, top: `${draftCrop.y * 100}%`, width: `${draftCrop.w * 100}%`, height: `${draftCrop.h * 100}%` }}>
                  <span className="third v1" /><span className="third v2" /><span className="third h1" /><span className="third h2" />
                  {["tl", "tr", "bl", "br", "t", "b", "l", "r"].map((kind) => <button key={kind} className={`crop-handle ${kind}`} aria-label={`${kind}ハンドル`} onPointerDown={(event) => onCropPointerDown(kind, event)} onPointerMove={onCropPointerMove} onPointerUp={() => { cropDragRef.current = null; }} />)}
                </div>
              </div>
            )}
          </div>
          <div className="stage-status">
            {comparing ? <span className="compare-pill">BEFORE・元画像</span> : <span>長押しで元画像を比較</span>}
          </div>
          {files.length > 1 && <button className="batch-chip" onClick={() => setSaveOpen(true)}>{files.length}枚を選択中</button>}
        </div>

        {tool && <aside className="tool-panel">
          <div className="panel-heading">
            <div><small>{tool === "resize" ? "画像そのものを再サンプリング" : tool === "crop" ? "画像データを実際に切り取り" : "非破壊でリアルタイム反映"}</small><h2>{{ crop: "トリミング", resize: "解像度", brightness: "明るさ", effects: "エフェクト", transform: "変形" }[tool]}</h2></div>
            <button className="close-panel" onClick={() => setTool(null)}>×</button>
          </div>

          {tool === "crop" && <>
            <div className="scroll-row ratio-row">
              {(["free", "original", "1:1", "4:3", "3:2", "16:9", "9:16"] as CropRatio[]).map((ratio) => <button key={ratio} className={cropRatio === ratio ? "selected" : ""} onClick={() => setCropRatioPreset(ratio)}>{ratio === "free" ? "自由" : ratio === "original" ? "元画像" : ratio}</button>)}
            </div>
            <div className="panel-actions three">
              <button onClick={() => setDraftCrop({ x: (1 - draftCrop.w) / 2, y: (1 - draftCrop.h) / 2, w: draftCrop.w, h: draftCrop.h })}>中央合わせ</button>
              <button onClick={() => setDraftCrop({ ...FULL_CROP })}>リセット</button>
              <button className="accent" onClick={applyCrop}>切り取りを反映</button>
            </div>
          </>}

          {tool === "resize" && <>
            <div className="resolution-grid">
              {RESOLUTIONS.map(([label, edge]) => {
                const dims = edge === 0 ? { width: Math.round(source.width * edit.crop.w), height: Math.round(source.height * edit.crop.h) } : dimensionsForLongEdge(edge, sourceCropAspect);
                const active = edit.outputWidth === dims.width && edit.outputHeight === dims.height;
                return <button key={label} className={active ? "selected" : ""} onClick={() => setResolution(edge)}><strong>{label}</strong><small>{dims.width} × {dims.height}</small></button>;
              })}
            </div>
            <div className="custom-size">
              <label>幅<input inputMode="numeric" type="number" value={edit.outputWidth} onFocus={beginTransient} onBlur={endTransient} onChange={(event) => { const width = Math.max(1, Number(event.target.value)); setEdit((current) => current ? { ...current, outputWidth: width, outputHeight: current.lockAspect ? Math.max(1, Math.round(width / sourceCropAspect)) : current.outputHeight } : current); }} /><span>px</span></label>
              <button className={edit.lockAspect ? "lock active" : "lock"} onClick={() => applyEdit((current) => ({ ...current, lockAspect: !current.lockAspect }))}>{edit.lockAspect ? "比率固定" : "比率なし"}</button>
              <label>高さ<input inputMode="numeric" type="number" value={edit.outputHeight} onFocus={beginTransient} onBlur={endTransient} onChange={(event) => { const height = Math.max(1, Number(event.target.value)); setEdit((current) => current ? { ...current, outputHeight: height, outputWidth: current.lockAspect ? Math.max(1, Math.round(height * sourceCropAspect)) : current.outputWidth } : current); }} /><span>px</span></label>
            </div>
            <div className="quick-values"><button onClick={() => setResolution(Math.round(Math.max(source.width, source.height) * .5))}>50%</button><button onClick={() => setResolution(Math.round(Math.max(source.width, source.height) * .75))}>75%</button><button onClick={() => setResolution(Math.min(source.width, source.height))}>短辺基準</button><button onClick={() => setResolution(Math.max(source.width, source.height))}>長辺基準</button></div>
            <p className="panel-note">出力ファイルは上記の実寸pxへ高品質リサンプリングされます。キャンバスだけの変更ではありません。</p>
          </>}

          {tool === "brightness" && <>
            <div className="slider-block hero-slider"><div><span>明るさ</span><strong>{edit.filters.brightness}%</strong></div><input type="range" min="20" max="200" value={edit.filters.brightness} onPointerDown={beginTransient} onPointerUp={endTransient} onChange={(event) => setEdit((current) => current ? { ...current, filters: { ...current.filters, brightness: Number(event.target.value) } } : current)} /></div>
            <div className="panel-actions"><button onClick={() => applyEdit((current) => ({ ...current, filters: { ...current.filters, brightness: 100 } }))}>明るさをリセット</button></div>
          </>}

          {tool === "effects" && <>
            <div className="effect-grid">
              {[
                ["なし", "◎", { ...DEFAULT_FILTERS, brightness: edit.filters.brightness }],
                ["グレー", "◑", { ...edit.filters, grayscale: 100, invert: false }],
                ["高コントラスト", "◐", { ...edit.filters, contrast: 135 }],
                ["シャープ", "✦", { ...edit.filters, sharpen: 55 }],
                ["明るく", "☀", { ...edit.filters, brightness: 118 }],
                ["白黒反転", "◒", { ...edit.filters, invert: true }],
              ].map(([label, icon, filters]) => <button key={label as string} onClick={() => applyEdit((current) => ({ ...current, filters: filters as EditState["filters"] }))}><span>{icon as string}</span><small>{label as string}</small></button>)}
            </div>
            {[['コントラスト','contrast',50,180],['彩度','saturation',0,200],['シャープ','sharpen',0,100]].map(([label,key,min,max]) => <div className="slider-block compact" key={key as string}><div><span>{label as string}</span><strong>{edit.filters[key as keyof EditState["filters"]] as number}%</strong></div><input type="range" min={min as number} max={max as number} value={edit.filters[key as keyof EditState["filters"]] as number} onPointerDown={beginTransient} onPointerUp={endTransient} onChange={(event) => setEdit((current) => current ? { ...current, filters: { ...current.filters, [key as string]: Number(event.target.value) } } : current)} /></div>)}
          </>}

          {tool === "transform" && <>
            <div className="transform-actions">
              <button onClick={() => applyEdit((current) => ({ ...current, transform: { ...current.transform, rotation: current.transform.rotation - 90 } }))}><span>↶</span>左90°</button>
              <button onClick={() => applyEdit((current) => ({ ...current, transform: { ...current.transform, rotation: current.transform.rotation + 90 } }))}><span>↷</span>右90°</button>
              <button onClick={() => applyEdit((current) => ({ ...current, transform: { ...current.transform, flipX: !current.transform.flipX } }))}><span>↔</span>左右反転</button>
              <button onClick={() => applyEdit((current) => ({ ...current, transform: { ...current.transform, flipY: !current.transform.flipY } }))}><span>↕</span>上下反転</button>
            </div>
            <div className="slider-block"><div><span>傾き補正</span><strong>{edit.transform.straighten.toFixed(1)}°</strong></div><input type="range" min="-10" max="10" step="0.1" value={edit.transform.straighten} onPointerDown={beginTransient} onPointerUp={endTransient} onChange={(event) => setEdit((current) => current ? { ...current, transform: { ...current.transform, straighten: Number(event.target.value) } } : current)} /></div>
            <div className="panel-actions"><button onClick={resetTransform}>変形だけリセット</button></div>
            <p className="panel-note">移動・拡大縮小・回転はキャンバス上の配置です。画像の実寸pxは「解像度」で変更します。</p>
          </>}
        </aside>}
      </section>

      <nav className="tool-dock" aria-label="編集ツール">
        {[
          ["crop", "⌗", "トリミング"], ["resize", "↔", "解像度"], ["brightness", "☀", "明るさ"],
          ["effects", "◐", "エフェクト"], ["transform", "◇", "変形"], ["save", "⇧", "保存"],
        ].map(([key, icon, label]) => <button key={key} className={tool === key ? "active" : ""} onClick={() => key === "save" ? setSaveOpen(true) : switchTool(key as Tool)}><span>{icon}</span><small>{label}</small></button>)}
      </nav>

      {saveOpen && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setSaveOpen(false); }}>
        <section className="save-sheet" role="dialog" aria-modal="true" aria-label="保存前の確認">
          <div className="sheet-grabber" />
          <header><div><small>保存前の確認</small><h2>この内容で書き出します</h2></div><button onClick={() => setSaveOpen(false)}>×</button></header>
          <div className="output-summary"><div><small>出力サイズ</small><strong>{edit.outputWidth.toLocaleString()} × {edit.outputHeight.toLocaleString()} px</strong></div><div><small>推定容量</small><strong>{estimating ? "計算中…" : `約 ${formatBytes(estimate)}`}</strong></div></div>
          <div className="save-grid">
            <fieldset><legend>形式</legend><div className="segmented"><button className={edit.output.format === "image/png" ? "selected" : ""} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, format: "image/png", targetBytes: 0 } }))}>PNG<small>透明対応</small></button><button className={edit.output.format === "image/jpeg" ? "selected" : ""} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, format: "image/jpeg" } }))}>JPEG<small>容量を軽く</small></button></div></fieldset>
            <fieldset className={edit.output.format === "image/png" ? "disabled-group" : ""}><legend>JPEG画質・{qualityName(edit.output.quality)}</legend><input type="range" min="30" max="100" value={Math.round(edit.output.quality * 100)} disabled={edit.output.format === "image/png"} onPointerDown={beginTransient} onPointerUp={endTransient} onChange={(event) => setEdit((current) => current ? { ...current, output: { ...current.output, quality: Number(event.target.value) / 100 } } : current)} /><div className="range-labels"><span>軽量</span><strong>{Math.round(edit.output.quality * 100)}%</strong><span>高画質</span></div></fieldset>
            <fieldset><legend>目標ファイル容量</legend><select value={[0,102400,512000,1048576,2097152].includes(edit.output.targetBytes) ? edit.output.targetBytes : -1} disabled={edit.output.format === "image/png"} onChange={(event) => { const value = Number(event.target.value); if (value === -1) { setEdit((current) => current ? { ...current, output: { ...current.output, targetBytes: customTarget * 1024 } } : current); } else applyEdit((current) => ({ ...current, output: { ...current.output, targetBytes: value } })); }}><option value="0">制限なし</option><option value="102400">100KB以下</option><option value="512000">500KB以下</option><option value="1048576">1MB以下</option><option value="2097152">2MB以下</option><option value="-1">カスタム</option></select>{edit.output.format === "image/jpeg" && ![0,102400,512000,1048576,2097152].includes(edit.output.targetBytes) && <label className="inline-input"><input type="number" inputMode="numeric" value={customTarget} onChange={(event) => { const value = Number(event.target.value); setCustomTarget(value); setEdit((current) => current ? { ...current, output: { ...current.output, targetBytes: value * 1024 } } : current); }} />KB以下</label>}<small>JPEGは画質を優先し、必要な場合だけ寸法も縮小します。</small></fieldset>
            <fieldset><legend>EXIF</legend><div className="segmented"><button className={edit.output.exif === "remove" ? "selected" : ""} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, exif: "remove" } }))}>削除<small>位置情報も除去</small></button><button className={edit.output.exif === "keep" ? "selected" : ""} disabled={!source.exif || edit.output.format !== "image/jpeg"} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, exif: "keep" } }))}>保持<small>{source.exif ? "JPEGのみ" : "情報なし"}</small></button></div></fieldset>
            {edit.output.format === "image/jpeg" && <fieldset><legend>透明部分の背景</legend><div className="color-options"><button className={edit.output.background === "#ffffff" ? "selected white" : "white"} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, background: "#ffffff" } }))}>白</button><button className={edit.output.background === "#000000" ? "selected black" : "black"} onClick={() => applyEdit((current) => ({ ...current, output: { ...current.output, background: "#000000" } }))}>黒</button></div><small>JPEGは透明を保持できません。</small></fieldset>}
            <fieldset><legend>ファイル名</legend><div className="filename-row"><select value={edit.output.filenameMode} onChange={(event) => applyEdit((current) => ({ ...current, output: { ...current.output, filenameMode: event.target.value as EditState["output"]["filenameMode"] } }))}><option value="original">元ファイル名</option><option value="suffix">接尾辞を追加</option><option value="sequence">連番を付与</option></select><input aria-label="接尾辞" value={edit.output.suffix} onChange={(event) => setEdit((current) => current ? { ...current, output: { ...current.output, suffix: event.target.value } } : current)} /></div><small className="filename-preview">{outputFilename(source.file.name, edit)}</small></fieldset>
          </div>
          {!source.exif && edit.output.exif === "keep" && <p className="warning-box">元画像に保持できるEXIF情報がありません。</p>}
          <div className="export-actions"><button className="copy-button" onClick={() => void runExport("copy")}><span>▣</span><div><strong>画像をコピー</strong><small>Goodnotesへすぐ貼り付け</small></div></button><div className="export-secondary"><button onClick={() => void runExport("photos")}>写真に保存</button><button onClick={() => void runExport("download")}>ファイルに保存</button><button onClick={() => void runExport("share")}>共有</button></div></div>
          {files.length > 1 && <div className="batch-box"><div><strong>{files.length}枚を同じ設定で一括処理</strong><small>1枚ずつ処理して順番を維持します</small></div><button onClick={() => void runBatch()}>一括書き出し</button></div>}
        </section>
      </div>}

      {moreOpen && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setMoreOpen(false); }}><section className="side-sheet"><header><div><small>設定と再利用</small><h2>編集設定</h2></div><button onClick={() => setMoreOpen(false)}>×</button></header><div className="settings-buttons"><button onClick={copySettings}><span>＋</span><div><strong>編集設定をコピー</strong><small>解像度・補正・変形・保存設定</small></div></button><button onClick={pasteSettings}><span>↓</span><div><strong>編集設定を貼り付け</strong><small>別の画像にも同じ設定を適用</small></div></button></div><h3>マイプリセット <small>{presets.length}/10</small></h3>{presets.length > 0 && <div className="preset-list">{presets.map((preset, index) => <div key={`${preset.name}-${index}`}><button onClick={() => applyPreset(preset)}><strong>{preset.name}</strong><small>長辺 {preset.longEdge}px・{preset.output.format === "image/png" ? "PNG" : "JPEG"}</small></button><button aria-label={`${preset.name}を削除`} onClick={() => { const next = presets.filter((_, item) => item !== index); setPresets(next); localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); }}>×</button></div>)}</div>}<div className="new-preset"><input maxLength={18} placeholder="例：Goodnotes用" value={presetName} onChange={(event) => setPresetName(event.target.value)} /><button disabled={!presetName.trim() || presets.length >= 10} onClick={savePreset}>保存</button></div><hr /><button className="danger-soft" onClick={resetAll}>画像全体を完全リセット</button></section></div>}

      {helpOpen && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="help-sheet"><header><div><small>指だけで使えます</small><h2>操作ガイド</h2></div><button onClick={() => setHelpOpen(false)}>×</button></header><div className="gesture-list"><div><span>☝</span><div><strong>1本指で移動</strong><small>画像を好きな位置へ</small></div></div><div><span>↔</span><div><strong>2本指で拡大・回転</strong><small>ピンチとひねりを同時に認識</small></div></div><div><span>◎</span><div><strong>ダブルタップでフィット</strong><small>配置だけをすぐリセット</small></div></div><div><span>◉</span><div><strong>長押しでBefore</strong><small>離すと編集後へ戻る</small></div></div></div><p>解像度変更・トリミング・キャンバス上の配置は、それぞれ独立して管理されます。</p><button className="accent wide" onClick={() => setHelpOpen(false)}>わかりました</button></section></div>}

      {batchProgress && <div className="progress-overlay"><div className="progress-card"><span className="spinner" /><h2>{batchProgress.current} / {batchProgress.total} 処理中</h2><div className="progress-track"><i style={{ width: `${batchProgress.current / batchProgress.total * 100}%` }} /></div><p>残り推定 {elapsedLabel}</p><button onClick={() => { cancelBatchRef.current = true; }}>キャンセル</button></div></div>}
      {busy && !batchProgress && <div className="loading-overlay"><span className="spinner" />高品質で処理中…</div>}
      {toast && <div className={`toast ${toast.tone === "warn" ? "warning" : ""}`}>{toast.tone === "warn" ? "!" : "✓"} {toast.text}</div>}
    </main>
  );
}
