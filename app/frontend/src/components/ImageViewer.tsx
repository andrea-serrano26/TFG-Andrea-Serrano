import React, { useState, useRef, useCallback, useEffect } from "react";

//--------------------------------------------------------------------------------------------------------------------------------
//PROPS DEL COMPONENTE ImageViewer

interface ImageViewerProps {
  title:             string;                                   //"VISTA AXIAL", "VISTA SAGITAL" o "VISTA CORONAL"
  slice:             number;                                   //Índice del slice actual
  onSliceChange:     (value: number) => void;                  //Función para actualizar el slice actual
  view:              "axial" | "sagital" | "coronal";
  imageSrc?:         string;                                   //Base64 o URL de la imagen a mostrar
  maskSrc?:          string;                                   //Base64 o URL de la máscara de segmentación
  maxSlices?:        number;                                   //Número total de slices disponibles (para el slider)

  // Estados y callbacks para zoom, pan, contraste y posición del crosshair, compartidos entre vistas
  sharedZoom?:       number;                                   //Nivel de zoom actual (1.0 = 100%)
  onZoomChange?:     (zoom: number) => void;                   //Función para actualizar el nivel de zoom
  panPosition?:      { x: number; y: number };                 //Posición actual del pan (desplazamiento) en píxeles
  onPanChange?:      (pan: { x: number; y: number }) => void;  //Función para actualizar la posición del pan
  sharedContrast?:   number;                                   //Nivel de contraste actual (100 = normal)
  onContrastChange?: (contrast: number) => void;               //Función para actualizar el nivel de contraste
  crosshairPos?:     { x: number; y: number };                 //Posición del crosshair en coordenadas fraccionales (0 a 1) dentro de la imagen
  onCrosshairMove?:  (pos: { x: number; y: number }) => void;  //Función para actualizar la posición del crosshair
  onDoubleClick?:    () => void;                               //Función para manejar el doble clic (ej. para restablecer zoom y pan)
}
//--------------------------------------------------------------------------------------------------------------------------------

//---------------------------------------------------------------------------------------------------------------------------------
// CONSTANTES Y TIPOS AUXILIARES
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 8.0;
const HIT_PX = 9;

// "none" = no se está arrastrando nada
// "h" = arrastrando línea horizontal (ajusta coordenada Y del crosshair)
// "v" = arrastrando línea vertical (ajusta coordenada X del crosshair)
// "both" = arrastrando el punto de intersección (ajusta ambas coordenadas del crosshair)
// "contrast" = arrastrando con clic derecho para ajustar contraste
type DragTarget = "none" | "both" | "h" | "v" | "contrast"; 
//---------------------------------------------------------------------------------------------------------------------------------

//----------------------------------------------------------------------------------------------------------------------------------
// HOOK PERSONALIZADO PARA SCROLL SUAVE ENTRE SLICES
// Maneja el scroll suave al cambiar de slice, animando la transición en lugar de saltar abruptamente.
function useSmoothScroll(
  currentSlice: number,
  onSliceChange: (v: number) => void,
  maxSlices: number
) {
  const targetRef = useRef(currentSlice);               //Slice objetivo
  const animRef   = useRef<number>(currentSlice);       //Slice actual de la animación (puede ser decimal durante la transición)
  const rafRef    = useRef<number | null>(null);        //Referencia al requestAnimationFrame activo (si hay)

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const target  = targetRef.current;
      const current = animRef.current;
      const dist    = target - current;
      if (Math.abs(dist) < 0.5) {
        animRef.current = target;
        onSliceChange(target);
        rafRef.current = null;
        return;
      }
      const step  = dist * 0.18 + Math.sign(dist) * 0.4;
      const next  = Math.max(0, Math.min(maxSlices - 1, current + step));
      animRef.current = next;
      const ni = Math.round(next);
      if (ni !== Math.round(current)) onSliceChange(ni);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [onSliceChange, maxSlices]);

  const scrollTo = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(maxSlices - 1,
      Math.round(targetRef.current) + delta));
    targetRef.current = next;
    startLoop();
  }, [maxSlices, startLoop]);

  useEffect(() => {
    if (rafRef.current === null) {
      targetRef.current = currentSlice;
      animRef.current   = currentSlice;
    }
  }, [currentSlice]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  return scrollTo;
}
//----------------------------------------------------------------------------------------------------------------------------------

//----------------------------------------------------------------------------------------------------------------------------------
// COMPONENTE PRINCIPAL: ImageViewer

export function ImageViewer({
  title, slice, onSliceChange, view, imageSrc, maskSrc,
  maxSlices = 100,
  sharedZoom = 1.0,    onZoomChange,
  panPosition = { x: 0, y: 0 }, onPanChange,
  sharedContrast = 100, onContrastChange,
  crosshairPos = { x: 0.5, y: 0.5 }, onCrosshairMove,
  onDoubleClick,
}: ImageViewerProps) {

  const [dragTarget, setDragTarget] = useState<DragTarget>("none");
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState("crosshair");

  const contrastStartX = useRef(0);                                      //Posición X inicial al comenzar a arrastrar para contraste
  const imgRef = useRef<HTMLImageElement>(null);                         //Referencia a la imagen
  const containerRef = useRef<HTMLDivElement>(null);                     //Referencia al contenedor

  const scrollTo = useSmoothScroll(slice, onSliceChange, maxSlices);

  // Observa cambios en el tamaño del contenedor para ajustar la visualización
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  
  //----------------------------------------------------------------------------------------------------------------------------------

  //------------------------------------------------------------------------------------------------------------------------------------
  // FUNCIONES DE GEOMETRÍA: cálculo de posiciones y zonas de hit
  
  // Calcula la posición en píxeles del crosshair dentro del contenedor, considerando zoom, pan y tamaño de la imagen
  const getCrossPixels = useCallback(() => {
    const img = imgRef.current;
    if (!img || containerSize.w === 0) return null;
    const iw = img.offsetWidth  * sharedZoom;
    const ih = img.offsetHeight * sharedZoom;
    const imgLeft = containerSize.w / 2 + panPosition.x - iw / 2;
    const imgTop  = containerSize.h / 2 + panPosition.y - ih / 2;
    return {
      x: imgLeft + crosshairPos.x * iw,
      y: imgTop  + crosshairPos.y * ih,
      iw, ih, imgLeft, imgTop,
    };
  }, [containerSize, sharedZoom, panPosition, crosshairPos]);

  // Coordenadas crosshair para dibujar
  const cross = getCrossPixels();
  const crossX = cross?.x ?? containerSize.w / 2;
  const crossY = cross?.y ?? containerSize.h / 2;

  const sliderPct = maxSlices > 1 ? (slice / (maxSlices - 1)) * 100 : 0;

  // Color de cada línea: más vivo cuando está siendo arrastrada
  const colH = (dragTarget === "h" || dragTarget === "both")
    ? "rgba(0,225,255,1)" : "rgba(0,210,255,0.75)";
  const colV = (dragTarget === "v" || dragTarget === "both")
    ? "rgba(0,225,255,1)" : "rgba(0,210,255,0.75)";

  // Determina qué zona se está tocando
  const getHitTarget = useCallback((clientX: number, clientY: number): DragTarget => {
    const cont = containerRef.current; if (!cont) return "none";
    const rect  = cont.getBoundingClientRect();
    const cross = getCrossPixels();    if (!cross) return "none";

    const dx = Math.abs(clientX - rect.left  - cross.x);  // Distancia horizontal al crosshair
    const dy = Math.abs(clientY - rect.top   - cross.y);  // Distancia vertical al crosshair
    const nearV = dx <= HIT_PX;
    const nearH = dy <= HIT_PX;

    if (nearV && nearH) return "both";
    if (nearV)          return "v";
    if (nearH)          return "h";
    return "none";
  }, [getCrossPixels]);

  // Convierte coordenadas de pantalla (clientX/Y) a coordenadas fraccionales (0 a 1) dentro de la imagen, considerando zoom y pan
  const screenToFrac = useCallback((clientX: number, clientY: number) => {
    const cont = containerRef.current;
    const img  = imgRef.current;
    if (!cont || !img) return null;
    const rect = cont.getBoundingClientRect();
    const iw = img.offsetWidth  * sharedZoom;
    const ih = img.offsetHeight * sharedZoom;
    const imgLeft = rect.width  / 2 + panPosition.x - iw / 2;
    const imgTop = rect.height / 2 + panPosition.y - ih / 2;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left - imgLeft) / iw)),
      y: Math.max(0, Math.min(1, (clientY - rect.top  - imgTop)  / ih)),
    };
  }, [sharedZoom, panPosition]);

  //--------------------------------------------------------------------------------------------------------------------------------------

  //------------------------------------------------------------------------------------------------------------------------------------
  // MANEJO DE EVENTOS DE INTERACCIÓN

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      const container = containerRef.current; if (!container) return;
      const rect      = container.getBoundingClientRect();
      const cx        = e.clientX - rect.left - rect.width  / 2;
      const cy        = e.clientY - rect.top  - rect.height / 2;
      const factor    = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZoom   = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, sharedZoom * factor));
      const sd        = newZoom / sharedZoom;
      onZoomChange?.(newZoom);
      onPanChange?.({ x: cx + (panPosition.x - cx) * sd, y: cy + (panPosition.y - cy) * sd });
    } else {
      scrollTo(e.deltaY > 0 ? -1 : 1);
    }
  }, [sharedZoom, panPosition, onZoomChange, onPanChange, scrollTo]);

 
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Drag activo
    if (dragTarget === "contrast") {
      const dx = e.clientX - contrastStartX.current;
      contrastStartX.current = e.clientX;
      onContrastChange?.(Math.max(50, Math.min(300, sharedContrast + dx * 0.8)));
      return;
    }
    if (dragTarget !== "none") {
      const frac = screenToFrac(e.clientX, e.clientY);
      if (!frac) return;
      if (dragTarget === "both") {
        onCrosshairMove?.(frac);
      } else if (dragTarget === "h") {
        onCrosshairMove?.({ x: crosshairPos.x, y: frac.y });
      } else if (dragTarget === "v") {
        onCrosshairMove?.({ x: frac.x, y: crosshairPos.y });
      }
      return;
    }

    // Sin drag: actualizar cursor por zona
    const hit = getHitTarget(e.clientX, e.clientY);
    if (hit === "both") setCursor("move");
    else if (hit === "h") setCursor("ns-resize");
    else if (hit === "v") setCursor("ew-resize");
    else setCursor("crosshair");
  }, [dragTarget, sharedContrast, onContrastChange, screenToFrac, onCrosshairMove,
      crosshairPos, getHitTarget]);


  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      setDragTarget("contrast");
      contrastStartX.current = e.clientX;
      setCursor("ew-resize");
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

    const hit = getHitTarget(e.clientX, e.clientY);
    if (hit === "none") return;   // fuera de las líneas: no hace nada

    setDragTarget(hit);
    if (hit === "both") setCursor("move");
    else if (hit === "h") setCursor("ns-resize");
    else if (hit === "v") setCursor("ew-resize");

    // Mueve inmediatamente
    const frac = screenToFrac(e.clientX, e.clientY);
    if (!frac) return;
    if (hit === "both") {
      onCrosshairMove?.(frac);
    } else if (hit === "h") {
      onCrosshairMove?.({ x: crosshairPos.x, y: frac.y });
    } else if (hit === "v") {
      onCrosshairMove?.({ x: frac.x, y: crosshairPos.y });
    }
  }, [getHitTarget, screenToFrac, onCrosshairMove, crosshairPos]);


  const handleMouseUp    = useCallback(() => { setDragTarget("none"); setCursor("crosshair"); }, []);
  
  const handleMouseLeave = useCallback(() => { setDragTarget("none"); setCursor("crosshair"); }, []);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragTarget("contrast");
    contrastStartX.current = e.clientX;
    setCursor("ew-resize");
  }, []);

  const handleReset = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onZoomChange?.(1.0);
    onPanChange?.({ x: 0, y: 0 });
  }, [onZoomChange, onPanChange]);

  //------------------------------------------------------------------------------------------------------------------------------------

  //------------------------------------------------------------------------------------------------------------------------------------
  // RENDERIZADO DEL COMPONENTE
  return (
    <div className="h-full flex flex-col bg-black overflow-hidden select-none">

      {/* Cabecera */}
      <div className="bg-black px-3 py-1.5 border-b border-gray-800 flex-shrink-0 flex items-center justify-between">
        <p className="text-[#ffcf26] text-[10px] font-bold uppercase tracking-widest">
          {title.replace("VISTA ", "")}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-[10px] font-mono">{slice + 1}/{maxSlices}</span>
          <button
            onClick={handleReset}
            title="Restablecer zoom y posición"
            className="text-gray-500 hover:text-[#ffcf26] transition-colors text-sm leading-none"
          >⌂</button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-black">
        <div
          ref={containerRef}
          className="absolute inset-0 flex items-center justify-center"
          style={{ cursor }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={onDoubleClick}
          onContextMenu={handleContextMenu}
        >
          {/* Imagen */}
          <div style={{
            transform: `translate(${panPosition.x}px, ${panPosition.y}px) scale(${sharedZoom})`,
            transformOrigin: "center center",
            transition: "none",
            pointerEvents: "none",
            display: "inline-flex",
          }}>
            {imageSrc ? (
              <div style={{ position: "relative", lineHeight: 0, display: "inline-block" }}>
                <img
                  ref={imgRef}
                  src={imageSrc} alt={title} draggable={false}
                  style={{
                    display: "block",
                    maxWidth:  containerSize.w > 0 ? `${containerSize.w}px` : "100vw",
                    maxHeight: containerSize.h > 0 ? `${containerSize.h}px` : "100vh",
                    width: "auto", height: "auto",
                    filter: `contrast(${sharedContrast ?? 100}%) brightness(1.05)`,
                    // Zoom <1.5: auto (bilineal, suaviza al alejar)
                    // Zoom >=1.5: pixelated (muestra píxeles reales del CT, como visor profesional)
                    imageRendering: sharedZoom >= 1.5 ? "pixelated" : "auto",
                  }}
                />
                {maskSrc && (
                  <img src={maskSrc} alt="mask" draggable={false}
                    style={{
                      position: "absolute", inset: 0,
                      width: "100%", height: "100%",
                      opacity: 0.65, display: "block", imageRendering: "auto",
                    }}
                  />
                )}
              </div>
            ) : (
              <span className="text-gray-600 text-xs font-mono animate-pulse tracking-widest">
                CARGANDO...
              </span>
            )}
          </div>

          {/* ── Crosshair ─────────────────────────────────────────────── */}
          {imageSrc && (
            <>
              {/* Zona de hit visual: línea horizontal — cursor ns-resize al hover */}
              <div style={{
                position: "absolute",
                top: `${crossY - HIT_PX}px`, left: 0, right: 0,
                height: `${HIT_PX * 2 + 1}px`,
                cursor: dragTarget === "none" ? "ns-resize" : undefined,
                pointerEvents: "none",   // el div padre captura los eventos
              }} />

              {/* Línea horizontal */}
              <div style={{
                position: "absolute",
                top: `${crossY}px`, left: 0, right: 0,
                height: "1px",
                background: colH,
                pointerEvents: "none",
                boxShadow: dragTarget === "h" || dragTarget === "both"
                  ? "0 0 4px rgba(0,225,255,0.8)" : "none",
              }} />

              {/* Línea vertical */}
              <div style={{
                position: "absolute",
                left: `${crossX}px`, top: 0, bottom: 0,
                width: "1px",
                background: colV,
                pointerEvents: "none",
                boxShadow: dragTarget === "v" || dragTarget === "both"
                  ? "0 0 4px rgba(0,225,255,0.8)" : "none",
              }} />

              {/* Círculo de intersección */}
              <div style={{
                position: "absolute",
                left: `${crossX - 5}px`,
                top:  `${crossY - 5}px`,
                width: "11px", height: "11px",
                borderRadius: "50%",
                border: `1.5px solid ${dragTarget === "both" ? "rgba(0,225,255,1)" : "rgba(0,210,255,0.85)"}`,
                background: dragTarget === "both" ? "rgba(0,225,255,0.18)" : "transparent",
                pointerEvents: "none",
                boxShadow: dragTarget === "both" ? "0 0 6px rgba(0,225,255,0.7)" : "none",
              }} />
            </>
          )}
        </div>

        {/* Slider vertical */}
        <div className="absolute left-0 top-0 bottom-0 flex items-center justify-center py-3 z-10"
             style={{ width: "12px" }}>
          <div style={{ position: "relative", height: "88%", width: "2px" }}>
            <div style={{
              position: "absolute", inset: 0, borderRadius: "1px",
              background: `linear-gradient(to top, #ffcf26 0%, #ffcf26 ${sliderPct}%,
                rgba(255,255,255,0.12) ${sliderPct}%, rgba(255,255,255,0.12) 100%)`,
            }} />
            <input type="range" min={0} max={maxSlices - 1} value={slice}
              onChange={e => onSliceChange(Number(e.target.value))}
              style={{
                position: "absolute", writingMode: "vertical-lr", direction: "rtl",
                WebkitAppearance: "slider-vertical",
                width: "12px", height: "100%", top: 0, left: "-5px",
                opacity: 0, cursor: "pointer", margin: 0, padding: 0,
              } as React.CSSProperties}
            />
          </div>
        </div>
      </div>
    </div>
  );
}