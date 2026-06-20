import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Paintbrush, Eraser, Check } from 'lucide-react';
import { Button } from './ui/button';
import { PatientInfo } from './PatientInfo';
import { Slider } from './ui/slider';
import { TumorViewer3D } from './TumorViewer3D';

//-----------------------------------------------------------------------------------------------------------------------------------
// TIPOS Y CONSTANTES
type View = 'axial' | 'sagital' | 'coronal';
type Tool = 'brush' | 'eraser' | null;
type PanMap = Record<View, { x: number; y: number }>;

const MIN_ZOOM    = 0.8;
const MAX_ZOOM    = 10.0;
const DEBOUNCE_MS = 10;
const UNDO_LIMIT  = 30;

//-----------------------------------------------------------------------------------------------------------------------------------

//-----------------------------------------------------------------------------------------------------------------------------------
// FUNCIÓN AUXILIAR
// Dado un volumen de máscara (valores 0,1,2) y las dimensiones del CT, pinta la máscara del slice actual en un canvas.
function renderMaskToCanvas(
  mc: HTMLCanvasElement,
  vol: Uint8Array,
  Z: number, Y: number, X: number,
  view: View, idx: number,
  sp: { x: number; y: number; z: number },
  maskOpacity = 65
) {
  let rows: number, cols: number;
  let getVal: (r: number, c: number) => number;
  
  //Cada vista tiene una forma distinta de acceder al volumen 3D. 
  // Para la vista axial el slice es un plano Z fijo, así que el índice base es idx * Y * X y se recorre Y (filas) y X (columnas). 
  // Para la vista sagital el slice es un plano X fijo (idx en la tercera dimensión), y las filas son Z pero con Z-1-r para invertir 
  // el eje vertical igual que hace el backend con np.flipud. 
  // Para la coronal el slice es un plano Y fijo (idx en la segunda dimensión), también con inversión de Z.
  if (view === 'axial') {
    rows = Y; cols = X;
    getVal = (r, c) => vol[idx * Y * X + r * X + c];
  } else if (view === 'sagital') {
    rows = Z; cols = Y;
    getVal = (r, c) => vol[(Z - 1 - r) * Y * X + c * X + idx];
  } else {
    rows = Z; cols = X;
    getVal = (r, c) => vol[(Z - 1 - r) * Y * X + idx * X + c];
  }
  
  if (mc.width !== cols || mc.height !== rows) {
    mc.width = cols;
    mc.height = rows;
  }
  
  //ImageData es un buffer RGBA plano donde cada píxel ocupa 4 bytes consecutivos. 
  // El bucle doble recorre todos los píxeles del slice y si el vóxel tiene valor 2 (tumor) lo pinta de amarillo con la opacidad 
  // configurada. Los píxeles donde el vóxel es 0 quedan con todos los bytes a 0, es decir transparentes. 
  // putImageData vuelca el buffer al canvas de una sola llamada.
  const alpha = Math.round((maskOpacity / 100) * 255);
  const idata = new ImageData(cols, rows);
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = getVal(r, c);
      if (val === 1 || val === 2) { 
        const i = (r * cols + c) * 4;
        idata.data[i] = 255;
        idata.data[i+1] = 207;
        idata.data[i+2] = 38;
        idata.data[i+3] = alpha;
      }
    }
  }
  
  mc.getContext('2d')!.putImageData(idata, 0, 0);
  mc.style.width = '100%';
  mc.style.height = '100%';
  mc.style.objectFit = 'contain';
}

//-----------------------------------------------------------------------------------------------------------------------------------

//-----------------------------------------------------------------------------------------------------------------------------------
// SliceEditor (subcomponente) 
interface SliceEditorProps {
  title:       string;
  ctSrc?:      string;
  maskCanvas:  HTMLCanvasElement | null;
  maskVersion: number;
  maskOpacity: number;
  contrast:    number;           
  view:        View;
  slice:       number;
  maxSlices:   number;
  tool:        Tool;
  brushSize:   number;
  zoom:        number;
  pan:         { x: number; y: number };
  crosshairPos:    { x: number; y: number };    
  onSliceChange:   (n: number) => void;
  onZoomChange:    (z: number) => void;
  onPanChange:     (p: { x: number; y: number }) => void;
  onContrastChange:(c: number) => void;          
  onCrosshairMove: (pos: { x: number; y: number }) => void; 
  onPaintPoint:(view: View, slice: number, px: number, py: number,
               cw: number, ch: number, tool: 'brush'|'eraser') => void;
  onStrokeEnd: (view: View, slice: number) => void;
  onDoubleClick?: () => void;
}

// Editor de un solo slice: maneja la visualización del CT, la superposición de la máscara, el cursor, y los eventos de interacción.
function SliceEditor({
  title, ctSrc, maskCanvas, maskVersion, maskOpacity, contrast,
  view, slice, maxSlices, tool, brushSize, zoom, pan,
  onSliceChange, onZoomChange, onPanChange, onContrastChange,
  onPaintPoint, onStrokeEnd, onDoubleClick,
}: SliceEditorProps) {
  
  // Refs para elementos DOM y estados mutables que no requieren re-renderizado
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const cursorRef    = useRef<HTMLCanvasElement>(null);
  const imgRef       = useRef<HTMLImageElement | null>(null);  // ref del <img> CT en el DOM

  // Estados mutables que no necesitan re-renderizar el componente
  const painting      = useRef(false);
  const contMode      = useRef(false);
  const contrastX     = useRef(0);
  const cursorPos     = useRef({ x: -1, y: -1 });
  const [contSize,    setContSize]    = useState({ w: 0, h: 0 });

  // Cola de slices para cambios rápidos 
  const sliceQueue = useRef<number[]>([]); // Cuando el usuario hace scroll rápido, en lugar de procesar cada evento de slice inmediatamente, 
  // los encolamos y los procesamos uno a uno usando requestAnimationFrame. Esto evita sobrecargar el navegador con demasiados cambios de slice en un corto período.
  
  const rafId = useRef<number | null>(null); // ID de la animación en curso para procesar la cola de slices. Si es null, no hay animación en curso.
  const flushQueue = useCallback(() => {
    // Procesa el siguiente slice en la cola. Si la cola no está vacía después de procesar, programa la siguiente llamada a flushQueue.
    rafId.current = null;
    const q = sliceQueue.current;
    if (q.length === 0) return;
    onSliceChange(q.shift()!);
    if (q.length > 0) rafId.current = requestAnimationFrame(flushQueue);
  }, [onSliceChange]);

  const enqueueSlice = useCallback((s: number) => {
    // Agrega un nuevo slice a la cola, asegurándose de que esté dentro de los límites. Si el nuevo slice es el mismo que el último 
    // en la cola, lo ignora para evitar cambios redundantes.
    const cl = Math.max(0, Math.min(maxSlices - 1, s));
    const q  = sliceQueue.current;
    if (q.length > 0 && q[q.length - 1] === cl) return;
    q.push(cl);
    if (rafId.current === null) rafId.current = requestAnimationFrame(flushQueue);
  }, [maxSlices, flushQueue]);

  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  // ResizeObserver para detectar cambios en el tamaño del contenedor y ajustar el canvas en consecuencia
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setContSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) })
    );
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const dc = canvasRef.current; if (!dc || dc.width < 1) return;
    const ctx = dc.getContext('2d')!;
    // Limpiar: el canvas es TRANSPARENTE (solo contiene la máscara)
    ctx.clearRect(0, 0, dc.width, dc.height);
    // El CT ya lo dibuja el <img> nativo — aquí solo superponemos la máscara
    if (maskCanvas && maskCanvas.width > 0)
      ctx.drawImage(maskCanvas, 0, 0, dc.width, dc.height);
  }, [maskCanvas]);
  
  
  // El <img> en el JSX se actualiza con src={ctSrc} automáticamente.
  // Su onLoad={sizeCanvas} dimensiona canvas + img cuando la imagen está lista.
  // Si no hay imagen, limpiamos el canvas de máscara.
  useEffect(() => {
    if (!ctSrc) { draw(); }
  }, [ctSrc, draw]);


  const drawCursor = useCallback(() => {
    const cc = cursorRef.current; if (!cc || cc.width < 1) return;
    const ctx = cc.getContext('2d')!;
    ctx.clearRect(0, 0, cc.width, cc.height);
    if (!tool || cursorPos.current.x < 0) return;
    const { x, y } = cursorPos.current;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, brushSize / 2), 0, Math.PI * 2);
    ctx.fillStyle   = tool === 'brush' ? 'rgba(255,207,38,0.15)' : 'rgba(255,80,40,0.10)';
    ctx.strokeStyle = tool === 'brush' ? 'rgba(255,207,38,0.95)' : 'rgba(255,80,40,0.90)';
    ctx.lineWidth = 1.5 / zoom;
    ctx.fill(); ctx.stroke();
  }, [tool, brushSize, zoom]);

  
  const sizeCanvas = useCallback(() => {
    const dc = canvasRef.current; if (!dc || contSize.w < 1) return;
    const im = imgRef.current;
    let w = contSize.w, h = contSize.h;
    if (im && im.naturalWidth > 0) {
      // Calcular dimensiones respetando el aspect ratio de la imagen CT
      const r = im.naturalWidth / im.naturalHeight;
      if (w / h > r) w = Math.round(h * r); else h = Math.round(w / r);
      // Dimensionar el <img> explícitamente
      im.style.width  = w + 'px';
      im.style.height = h + 'px';
    } else { return; }  // imagen aún no cargada — onLoad lo llamará cuando esté lista
    // El canvas de máscara y el de cursor coinciden con el <img> en píxeles
    if (dc.width !== w || dc.height !== h) { dc.width = w; dc.height = h; }
    const cc = cursorRef.current;
    if (cc && (cc.width !== w || cc.height !== h)) { cc.width = w; cc.height = h; }
    draw();
  }, [contSize, draw]);

  useEffect(() => { sizeCanvas(); }, [contSize, ctSrc, sizeCanvas]);

  useEffect(() => { draw(); }, [maskVersion, maskOpacity, draw]);
  useEffect(() => { drawCursor(); }, [tool, brushSize, zoom, drawCursor]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      const cont = containerRef.current; if (!cont) return;
      const rect = cont.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width  / 2;
      const cy = e.clientY - rect.top  - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
      const sd = nz / zoom;
      onZoomChange(nz);
      onPanChange({ x: cx + (pan.x - cx) * sd, y: cy + (pan.y - cy) * sd });
    } else {
      enqueueSlice(slice + (e.deltaY > 0 ? -1 : 1));
    }
  }, [zoom, pan, slice, onZoomChange, onPanChange, enqueueSlice]);

  const canvasXY = useCallback((clientX: number, clientY: number) => {
    const dc = canvasRef.current; if (!dc) return { px: 0, py: 0 };
    const r = dc.getBoundingClientRect();
    return { px: (clientX - r.left) / zoom, py: (clientY - r.top) / zoom };
  }, [zoom]);

  //Control de ratón
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      contMode.current = true;
      contrastX.current = e.clientX;
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (tool) {
      painting.current = true;
      const { px, py } = canvasXY(e.clientX, e.clientY);
      const dc = canvasRef.current; if (!dc) return;
      onPaintPoint(view, slice, px, py, dc.width, dc.height, tool);
      draw();
    }
  }, [tool, view, slice, canvasXY, onPaintPoint, draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (contMode.current) {
      const dx = e.clientX - contrastX.current;
      contrastX.current = e.clientX;
      onContrastChange(Math.max(50, Math.min(300, contrast + dx * 0.8)));
      return;
    }
    const { px, py } = canvasXY(e.clientX, e.clientY);
    cursorPos.current = { x: px, y: py };
    drawCursor();
    if (painting.current) {
      const dc = canvasRef.current; if (!dc) return;
      onPaintPoint(view, slice, px, py, dc.width, dc.height, tool!);
      draw();
    }
  }, [tool, view, slice, contrast, canvasXY, onPaintPoint,
      onContrastChange, draw, drawCursor]);

  const stopAll = useCallback(() => {
    if (painting.current) { painting.current = false; onStrokeEnd(view, slice); }
    contMode.current = false;
    cursorPos.current = { x: -1, y: -1 };
    drawCursor();
  }, [view, slice, onStrokeEnd, drawCursor]);

  const sliderPct = maxSlices > 1 ? (slice / (maxSlices - 1)) * 100 : 0;
  const cursor    = tool ? 'none' : contMode.current ? 'ew-resize' : 'default';

  //---------------------------------------------------------------------------------------------------------------------------------

  //---------------------------------------------------------------------------------------------------------------------------------
  // RENDERIZADO DEL EDITOR DE SLICE
  return (
    <div className="h-full flex flex-col bg-black overflow-hidden select-none">
      <div className="bg-black px-3 py-1 border-b border-gray-800 flex-shrink-0 flex justify-between items-center">
        <span className="text-[#ffcf26] text-[10px] font-bold uppercase tracking-widest">{title}</span>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-[10px] font-mono">{slice + 1}/{maxSlices}</span>
          <button
            onClick={e => { e.stopPropagation(); onZoomChange(1.0); onPanChange({ x:0, y:0 }); }}
            title="Restablecer vista"
            className="text-gray-500 hover:text-[#ffcf26] transition-colors text-sm leading-none"
          >⌂</button>
        </div>
      </div>

      <div ref={containerRef}
           className="flex-1 relative overflow-hidden bg-black flex items-center justify-center"
           onDoubleClick={onDoubleClick}>
        <div style={{
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
          transition: 'none',
          display: 'inline-block', position: 'relative',
        }}>
          {/*
            Arquitectura de capas (de abajo a arriba):
              1. <img>   — CT en calidad nativa del navegador (GPU, Lanczos). Contraste vía CSS filter.
              2. canvas  — Solo máscara (fondo transparente). Recibe todos los eventos de dibujo.
              3. canvas  — Cursor visual (pointerEvents: none).
          */}
          <img
            ref={imgRef}
            src={ctSrc || undefined}
            alt=""
            draggable={false}
            onLoad={sizeCanvas}
            style={{
              display: ctSrc ? 'block' : 'none',
              filter: `contrast(${contrast}%)`,
              imageRendering: 'auto',   // el navegador usa Lanczos (alta calidad)
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          />
          <canvas ref={canvasRef}
            style={{
              position: 'absolute', top: 0, left: 0,
              display: 'block', cursor,
              // El canvas es transparente excepto donde hay máscara pintada
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={stopAll}
            onMouseLeave={stopAll}
            onContextMenu={e => e.preventDefault()}
          />
          <canvas ref={cursorRef}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          />
        </div>

        {!ctSrc && (
          <span className="absolute text-gray-600 text-xs font-mono animate-pulse">CARGANDO...</span>
        )}

        <div className="absolute left-0 top-0 bottom-0 flex items-center justify-center py-3 z-10"
             style={{ width: '12px' }}>
          <div style={{ position: 'relative', height: '88%', width: '2px' }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '1px',
              background: `linear-gradient(to top, #ffcf26 0%, #ffcf26 ${sliderPct}%,
                rgba(255,255,255,0.12) ${sliderPct}%, rgba(255,255,255,0.12) 100%)`,
            }} />
            <input type="range" min={0} max={maxSlices - 1} value={slice}
              onChange={e => enqueueSlice(Number(e.target.value))}
              style={{
                position: 'absolute', writingMode: 'vertical-lr', direction: 'rtl',
                WebkitAppearance: 'slider-vertical',
                width: '12px', height: '100%', top: 0, left: '-5px',
                opacity: 0, cursor: 'pointer', margin: 0, padding: 0,
              } as React.CSSProperties}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------------------------------------------------------------

// ----------------------------------------------------------------------------------------------------------------------------------
// EditorScreen PRINCIPAL 
export function EditorScreen({ sessionId, patientData, onSaveMask }: any) {
  const [axialSlice,   setAxialSlice]   = useState(0);
  const [sagitalSlice, setSagitalSlice] = useState(0);
  const [coronalSlice, setCoronalSlice] = useState(0);

  const [ctImages, setCtImages] = useState<Record<View, string | undefined>>({
    axial: undefined, sagital: undefined, coronal: undefined,
  });
  const [dimensions, setDimensions] = useState({ x: 100, y: 100, z: 100 });
  const [spacing,    setSpacing]    = useState({ x: 1.0, y: 1.0, z: 1.0 });
  const [zoom,       setZoom]       = useState(1.0);
  const [pans,       setPans]       = useState<PanMap>({
    axial: { x: 0, y: 0 }, sagital: { x: 0, y: 0 }, coronal: { x: 0, y: 0 },
  });

  const [maskOpacity,  setMaskOpacity]  = useState(65);
  const [contrast,     setContrast]     = useState(100);
  const [tool,         setTool]         = useState<Tool>(null);
  const [brushSize,    setBrushSize]    = useState(12);
  const [editCount,    setEditCount]    = useState(0);
  const [mesh3dKey,    setMesh3dKey]    = useState(0);
  const [expandedView, setExpandedView] = useState<string | null>(null);
  const [maskVersion,  setMaskVersion]  = useState(0);

  const [axialCross,   setAxialCross]   = useState({ x: 0.5, y: 0.5 });
  const [sagitalCross, setSagitalCross] = useState({ x: 0.5, y: 0.5 });
  const [coronalCross, setCoronalCross] = useState({ x: 0.5, y: 0.5 });

  const initDone    = useRef(false);
  const abortRef    = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maskVol     = useRef<Uint8Array | null>(null);
  const undoStack   = useRef<Uint8Array[]>([]);

  const maskOffscreen = useRef<Record<View, HTMLCanvasElement>>({
    axial:   document.createElement('canvas'),
    sagital: document.createElement('canvas'),
    coronal: document.createElement('canvas'),
  });

  const refreshMaskCanvas = useCallback((view: View, idx: number) => {
    const vol = maskVol.current; if (!vol) return;
    const { x: X, y: Y, z: Z } = dimensions;
    renderMaskToCanvas(maskOffscreen.current[view], vol, Z, Y, X, view, idx, spacing, maskOpacity);
  }, [dimensions, spacing, maskOpacity]);

  const refreshAllMasks = useCallback(() => {
    refreshMaskCanvas('axial',   axialSlice);
    refreshMaskCanvas('sagital', sagitalSlice);
    refreshMaskCanvas('coronal', coronalSlice);
    setMaskVersion(v => v + 1);
  }, [axialSlice, sagitalSlice, coronalSlice, refreshMaskCanvas]);

  useEffect(() => {
    if (!maskVol.current || !initDone.current) return;
    refreshAllMasks();
  }, [maskOpacity, refreshAllMasks]);

  // Fetch CT images
  useEffect(() => {
    if (!sessionId) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(
          `http://localhost:8000/api/get-views/${sessionId}/${axialSlice}/${sagitalSlice}/${coronalSlice}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) return;
        const data = await res.json();
        setCtImages({ axial: data.axial, sagital: data.sagital, coronal: data.coronal });
        if (data.dimensions && !initDone.current) {
          const d  = data.dimensions;
          const sp = data.spacing ?? { x: 1, y: 1, z: 1 };
          setDimensions(d); setSpacing(sp);
          const az = Math.floor(d.z/2), sx = Math.floor(d.x/2), cy = Math.floor(d.y/2);
          setAxialSlice(az); setSagitalSlice(sx); setCoronalSlice(cy);
          setAxialCross({ x: sx/Math.max(1,d.x-1), y: cy/Math.max(1,d.y-1) });
          setSagitalCross({ x: cy/Math.max(1,d.y-1), y: 1-az/Math.max(1,d.z-1) });
          setCoronalCross({ x: sx/Math.max(1,d.x-1), y: 1-az/Math.max(1,d.z-1) });

          const maskCtrl = new AbortController();
          let vol = new Uint8Array(d.z * d.y * d.x);
          try {
            const mres = await fetch(
              `http://localhost:8000/api/get-mask-volume/${sessionId}`,
              { signal: maskCtrl.signal }
            );
            if (mres.ok) {
              const mdata = await mres.json();
              if (mdata.success && mdata.data) {
                const bin    = atob(mdata.data);
                const loaded = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) loaded[i] = bin.charCodeAt(i);
                if (loaded.length === d.z * d.y * d.x) vol = loaded;
              }
            }
          } catch (e: any) {
            if (e.name !== 'AbortError') console.error('Error cargando máscara:', e);
          }

          maskVol.current = vol; undoStack.current = [];
          renderMaskToCanvas(maskOffscreen.current.axial,   vol, d.z,d.y,d.x,'axial',   az, sp, maskOpacity);
          renderMaskToCanvas(maskOffscreen.current.sagital, vol, d.z,d.y,d.x,'sagital', sx, sp, maskOpacity);
          renderMaskToCanvas(maskOffscreen.current.coronal, vol, d.z,d.y,d.x,'coronal', cy, sp, maskOpacity);
          setMaskVersion(v => v+1);
          if (vol.some(v => v > 0)) setMesh3dKey(k => k+1);
          initDone.current = true;
        } else if (data.dimensions) {
          setDimensions(data.dimensions);
          if (data.spacing) setSpacing(data.spacing);
        }
      } catch (e: any) { if (e.name !== 'AbortError') console.error(e); }
    }, DEBOUNCE_MS);
    
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [sessionId, axialSlice, sagitalSlice, coronalSlice, maskOpacity]);

  useEffect(() => {
    if (!maskVol.current || !initDone.current) return;
    refreshMaskCanvas('axial',   axialSlice);
    refreshMaskCanvas('sagital', sagitalSlice);
    refreshMaskCanvas('coronal', coronalSlice);
    setMaskVersion(v => v+1);
  }, [axialSlice, sagitalSlice, coronalSlice, refreshMaskCanvas]);

  // Crosshair 
  const handleAxialCrossMove = useCallback((pos: {x:number;y:number}) => {
    setAxialCross(pos);
    const newSag = Math.round(pos.x * (dimensions.x-1));
    const newCor = Math.round(pos.y * (dimensions.y-1));
    setSagitalSlice(newSag); setCoronalSlice(newCor);
    setSagitalCross(p => ({ ...p, x: pos.y }));
    setCoronalCross(p => ({ ...p, x: newSag/Math.max(1,dimensions.x-1) }));
  }, [dimensions]);

  const handleSagitalCrossMove = useCallback((pos: {x:number;y:number}) => {
    setSagitalCross(pos);
    const newCor = Math.round(pos.x*(dimensions.y-1));
    const newAx  = Math.round((1-pos.y)*(dimensions.z-1));
    setCoronalSlice(newCor); setAxialSlice(newAx);
    setAxialCross(p  => ({ ...p, y: newCor/Math.max(1,dimensions.y-1) }));
    setCoronalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);

  const handleCoronalCrossMove = useCallback((pos: {x:number;y:number}) => {
    setCoronalCross(pos);
    const newSag = Math.round(pos.x*(dimensions.x-1));
    const newAx  = Math.round((1-pos.y)*(dimensions.z-1));
    setSagitalSlice(newSag); setAxialSlice(newAx);
    setAxialCross(p   => ({ ...p, x: newSag/Math.max(1,dimensions.x-1) }));
    setSagitalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);

  // Undo
  const applyUndo = useCallback(() => {
    const stack = undoStack.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    maskVol.current = prev;
    refreshAllMasks();
    setEditCount(n => Math.max(0, n-1));
    setMesh3dKey(k => k+1);
    const { x:X, y:Y, z:Z } = dimensions;
    const views: [View,number][] = [
      ['axial',axialSlice],['sagital',sagitalSlice],['coronal',coronalSlice],
    ];
    views.forEach(([v,si]) => {
      let rows:number, cols:number;
      if(v==='axial'){rows=Y;cols=X;}
      else if(v==='sagital'){rows=Z;cols=Y;}
      else{rows=Z;cols=X;}
      const matrix:number[][]=[];
      for(let r=0;r<rows;r++){
        const row:number[]=[];
        for(let c=0;c<cols;c++){
          let val:number;
          if(v==='axial') val=prev[si*Y*X+r*X+c];
          else if(v==='sagital') val=prev[(Z-1-r)*Y*X+c*X+si];
          else val=prev[(Z-1-r)*Y*X+si*X+c];
          row.push(val);
        }
        matrix.push(row);
      }
      fetch(`http://localhost:8000/api/edit-mask-slice/${sessionId}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({view:v,slice_idx:si,mask_slice:matrix}),
      }).catch(console.error);
    });
  }, [dimensions, axialSlice, sagitalSlice, coronalSlice, refreshAllMasks, sessionId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey||e.ctrlKey) && e.key==='z' && !e.shiftKey) { e.preventDefault(); applyUndo(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [applyUndo]);

  // PINTAR CON BROCHA O BORRADOR
  const handlePaintPoint = useCallback((
    view:View, sliceIdx:number, px:number, py:number,
    canvasW:number, canvasH:number, paintTool:'brush'|'eraser'
  ) => {
    const vol = maskVol.current;
    const { x:X, y:Y, z:Z } = dimensions;
    const sp = spacing;
    if (!vol) return;

    // Paso 1: calcular dimensiones físicas de la imagen renderizada
    let physRows:number, physCols:number, spacingRow:number, spacingCol:number;
    if(view==='axial'){physRows=Y;physCols=X;spacingRow=sp.y;spacingCol=sp.x;}
    else if(view==='sagital'){physRows=Z;physCols=Y;spacingRow=sp.z;spacingCol=sp.y;}
    else{physRows=Z;physCols=X;spacingRow=sp.z;spacingCol=sp.x;}

    const minSp=Math.min(spacingRow,spacingCol);
    let imgH=Math.max(1,Math.round(physRows*spacingRow/minSp));
    let imgW=Math.max(1,Math.round(physCols*spacingCol/minSp));
    const sc=Math.min(1.0,2048/Math.max(imgH,imgW));
    imgH=Math.max(1,Math.round(imgH*sc)); 
    imgW=Math.max(1,Math.round(imgW*sc));

    // Paso 2: calcular el radio de la brocha en voxels, y el rango de filas/columnas afectadas
    const rVoxRow=(brushSize/2)*(physRows/imgH)*(imgH/canvasH);
    const rVoxCol=(brushSize/2)*(physCols/imgW)*(imgW/canvasW);

    // Paso 3: centro de la brocha en coordenadas de voxel
    const centerRow=(py/canvasH)*physRows;
    const centerCol=(px/canvasW)*physCols;

    // Paso 4: bounding box del pincel
    const r0=Math.max(0,Math.floor(centerRow-rVoxRow));
    const r1=Math.min(physRows-1,Math.ceil(centerRow+rVoxRow));
    const c0=Math.max(0,Math.floor(centerCol-rVoxCol));
    const c1=Math.min(physCols-1,Math.ceil(centerCol+rVoxCol));

    // Paso 5: pintar en el volumen dentro de la bounding box, usando la ecuación de la elipse para un pincel circular
    const val=paintTool==='brush' ? 2 : 0; 
    for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){
      const dr=(r-centerRow)/(rVoxRow||1);
      const dc=(c-centerCol)/(rVoxCol||1);
      if(dr*dr+dc*dc>1) continue;

      // Paso 6: convertir coordenadas 2D a índice del volumen 3D según la vista
      let vz:number,vy:number,vx:number;
      if(view==='axial'){vz=sliceIdx;vy=r;vx=c;}
      else if(view==='sagital'){vz=Z-1-r;vy=c;vx=sliceIdx;}
      else{vz=Z-1-r;vy=sliceIdx;vx=c;}
      if(vz>=0&&vz<Z&&vy>=0&&vy<Y&&vx>=0&&vx<X)
        vol[vz*Y*X+vy*X+vx]=val;
    }
    refreshMaskCanvas(view, sliceIdx);
    setMaskVersion(v => v+1);
  }, [dimensions, spacing, brushSize, refreshMaskCanvas]);

  // Cuando el usuario suelta el mouse después de pintar, guardamos un snapshot del volumen para undo, y enviamos el slice editado al backend
  const handleStrokeEnd = useCallback(async (view:View, sliceIdx:number) => {
    const vol = maskVol.current; if (!vol) return;

    // Guardar snapshot para undo
    const { x:X, y:Y, z:Z } = dimensions;
    const snap = vol.slice();
    const stack = undoStack.current;
    if (stack.length >= UNDO_LIMIT) stack.shift();
    stack.push(snap);
    setEditCount(n => n+1);
    
    // Enviar el slice editado al backend para que actualice la máscara almacenada. 
    // Para esto, extraemos el slice editado del volumen y lo convertimos a una matriz 2D según la vista.
    let rows:number, cols:number;
    if(view==='axial'){rows=Y;cols=X;}
    else if(view==='sagital'){rows=Z;cols=Y;}
    else{rows=Z;cols=X;}
    const matrix:number[][]=[];
    for(let r=0;r<rows;r++){
      const row:number[]=[];
      for(let c=0;c<cols;c++){
        let v:number;
        if(view==='axial') v=vol[sliceIdx*Y*X+r*X+c];
        else if(view==='sagital') v=vol[(Z-1-r)*Y*X+c*X+sliceIdx];
        else v=vol[(Z-1-r)*Y*X+sliceIdx*X+c];
        row.push(v);
      }
      matrix.push(row);
    }
    try {
      await fetch(`http://localhost:8000/api/edit-mask-slice/${sessionId}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({view, slice_idx:sliceIdx, mask_slice:matrix}),
      });
      setMesh3dKey(k => k+1);
    } catch(e){ console.error(e); }
  }, [sessionId, dimensions]);


  const handleSave = async () => {
    try {
      const res  = await fetch(`http://localhost:8000/api/save-mask/${sessionId}`);
      const data = await res.json();
      onSaveMask({ saved:true, voxels:data.voxels, sessionId });
    } catch { onSaveMask({ saved:false, sessionId }); }
  };

  const toggleTool   = (t:'brush'|'eraser') => setTool(p => p===t ? null : t);
  const toggleExpand = (v:string) => setExpandedView(p => p===v ? null : v);

  const viewDefs = [
    { id:'axial'   as View, title:'AXIAL',   slice:axialSlice,   set:setAxialSlice,   max:dimensions.z, cross:axialCross,   onCross:handleAxialCrossMove   },
    { id:'sagital' as View, title:'SAGITAL', slice:sagitalSlice, set:setSagitalSlice, max:dimensions.x, cross:sagitalCross, onCross:handleSagitalCrossMove },
    { id:'coronal' as View, title:'CORONAL', slice:coronalSlice, set:setCoronalSlice, max:dimensions.y, cross:coronalCross, onCross:handleCoronalCrossMove },
  ];

  const commonProps = {
    tool, brushSize, maskOpacity, contrast, zoom, maskVersion,
    onZoomChange:     setZoom,
    onContrastChange: setContrast,
    onPaintPoint:     handlePaintPoint,
    onStrokeEnd:      handleStrokeEnd,
  };

  const memoized3DViewer = useMemo(() => (
    <TumorViewer3D sessionId={sessionId} refreshKey={mesh3dKey} />
  ), [sessionId, mesh3dKey]);

  //----------------------------------------------------------------------------------------------------------------------------------

  //-----------------------------------------------------------------------------------------------------------------------------------
  // RENDERIZADO DEL EDITOR PRINCIPAL
  return (
    <div className="h-screen w-full bg-gray-900 flex flex-col overflow-hidden">
      <div className="bg-black border-b border-gray-700 p-2 flex-shrink-0">
        <PatientInfo data={patientData} />
      </div>

      {/* Vista expandida (modal) */}
      {expandedView && (
        <div className="fixed inset-0 z-50 bg-black/95" onDoubleClick={() => setExpandedView(null)}>
          <div className="w-full h-full p-4">
            {viewDefs.map(v => expandedView === v.id && (
              <SliceEditor key={v.id}
                title={v.title} ctSrc={ctImages[v.id]}
                maskCanvas={maskOffscreen.current[v.id]}
                view={v.id} slice={v.slice} maxSlices={v.max}
                pan={pans[v.id]}
                crosshairPos={v.cross} onCrosshairMove={v.onCross}
                onSliceChange={v.set}
                onPanChange={p => setPans(prev => ({ ...prev, [v.id]: p }))}
                {...commonProps}
              />
            ))}
            {expandedView === '3d' && <TumorViewer3D sessionId={sessionId} refreshKey={mesh3dKey} />}
          </div>
        </div>
      )}

      {/* Layout principal: Grid 2x2 + Panel lateral */}
      <div className="flex-1 flex overflow-hidden">
        {/* Grid de vistas 2x2 */}
        <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-1 p-1 bg-black min-w-0">
          {viewDefs.map(v => (
            <div key={v.id} className="bg-black border border-gray-700 overflow-hidden hover:border-[#ffcf26]/50 transition-colors">
              <SliceEditor
                title={v.title} ctSrc={ctImages[v.id]}
                maskCanvas={maskOffscreen.current[v.id]}
                view={v.id} slice={v.slice} maxSlices={v.max}
                pan={pans[v.id]}
                crosshairPos={v.cross} onCrosshairMove={v.onCross}
                onSliceChange={v.set}
                onPanChange={p => setPans(prev => ({ ...prev, [v.id]: p }))}
                onDoubleClick={() => toggleExpand(v.id)}
                {...commonProps}
              />
            </div>
          ))}
          {/* Cuadrante 3D */}
          <div className="bg-black border border-gray-700 overflow-hidden hover:border-[#ffcf26]/50 transition-colors"
            onDoubleClick={() => toggleExpand('3d')}>
            {memoized3DViewer}
          </div>
        </div>

        {/* Panel lateral de herramientas */}
        <div className="w-72 flex-shrink-0 bg-black border-l border-gray-700 flex flex-col p-4 gap-4 overflow-y-auto">
          
          {/* Herramientas */}
          <div>
            <p className="text-yellow-500 text-[10px] uppercase tracking-widest mb-2 font-bold">SELECCIÓN DE HERRAMIENTA</p>
            <div className="flex gap-2">
              <Button onClick={() => toggleTool('brush')}
                className={`flex-1 h-14 flex flex-col items-center justify-center gap-1 text-xs font-bold
                  ${tool==='brush' ? 'bg-yellow-700 border-2 border-yellow-500 hover:bg-yellow-600'
                  : 'bg-black border border-gray-600 hover:bg-yellow-500'} text-white`}>
                <Paintbrush className="w-5 h-5" />Pincel
              </Button>
              <Button onClick={() => toggleTool('eraser')}
                className={`flex-1 h-14 flex flex-col items-center justify-center gap-1 text-xs font-bold
                  ${tool==='eraser' ? 'bg-orange-700 border-2 border-orange-500 hover:bg-orange-600'
                  : 'bg-black border border-gray-600 hover:bg-orange-500'} text-white`}>
                <Eraser className="w-5 h-5" />Borrador
              </Button>
            </div>
          </div>

          {/* Tamaño pincel y opacidad */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-gray-500 text-[10px] uppercase tracking-widest">Tamaño pincel</p>
              <div className="flex items-center gap-1">
                <div className={`rounded-full ${tool==='eraser'?'bg-orange-500':'bg-yellow-500'}`}
                  style={{width:`${Math.min(brushSize,50)}px`,height:`${Math.min(brushSize,50)}px`,
                          minWidth:'1px',minHeight:'1px',opacity:tool?1:0.3}} />
                <span className="text-gray-400 text-xs font-mono w-8 text-right">{brushSize}px</span>
              </div>
            </div>
            <Slider value={[brushSize]} onValueChange={([v]: number[]) => setBrushSize(v)} min={1} max={50} step={1} className="w-full" />

            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-gray-500 text-[10px] uppercase tracking-widest">Opacidad máscara</p>
                <span className="text-gray-400 text-xs font-mono">{maskOpacity}%</span>
              </div>
              <Slider value={[maskOpacity]} onValueChange={([v]: number[]) => setMaskOpacity(v)} min={0} max={100} step={1} className="w-full" />
            </div>
          </div>

          <div className="mt-auto pt-4 border-t border-gray-600">
            <Button onClick={handleSave}
              className="w-full bg-transparent hover:bg-[#ffcf26]/10 text-[#ffcf26] border-2 border-[#ffcf26] h-10 text-sm">
              <Check className="mr-2 w-4 h-4" />Guardar segmentación y continuar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
// -----------------------------------------------------------------------------------------------------------------------------------