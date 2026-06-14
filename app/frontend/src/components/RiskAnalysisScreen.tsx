import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Home, AlertCircle, CheckCircle, Loader2, FlaskConical, Save, ExternalLink, Pencil } from 'lucide-react';
import { PatientInfo }   from './PatientInfo';
import { ImageViewer }   from './ImageViewer';
import { TumorViewer3D } from './TumorViewer3D';

//--------------------------------------------------------------------------------------------------------------------------------
//PROPS Y TIPOS RELACIONADOS

// Tipo de resultado del análisis radiómico
// - diagnostico: texto del diagnóstico 
// - probabilidad: porcentaje de probabilidad de malignidad 
// - isBenign: booleano indicando si se considera benigno (usado para colores y texto)
// - source: indica si el diagnóstico viene del modelo o de una heurística (para mostrar en el informe)
// - metricas: métricas morfológicas clave (volumen, diámetro máximo)
// - radiomicsHighlight: diccionario de features radiómicas destacadas (nombre: valor) para mostrar en el informe
interface AnalysisResult {
  diagnostico:   string;
  probabilidad:  number;
  isBenign:      boolean;
  source:        'model' | 'heuristic';
  metricas: {
    volumen: number; diametroMaximo: number;
  };
  radiomicsHighlight: Record<string, number>;
}

// Props del componente principal de análisis de riesgo
// sessionId: ID de sesión para fetchs relacionados
// patientData: datos básicos del paciente para mostrar y usar en el informe
// source: indica el origen del análisis (viewer/editor/saved) para ajustar comportamientos
// savedAnalysis: si viene dado, se muestra directamente sin hacer fetch (usado para análisis guardados)
// onBackToLoad: callback para volver a la pantalla de carga
// onGoToEditor: callback para ir al editor de máscaras (en caso de error en el análisis)
interface Props {
  sessionId:       string;
  patientData:     { id: string; nombre: string; sexo: string; fechaAdquisicion: string };
  source:          'viewer' | 'editor' | 'saved'; 
  savedImages?:    any;
  savedAnalysis?:  AnalysisResult | null;
  onBackToLoad:    () => void;
  onGoToEditor:    () => void;
}

// Formatea fechas en formato YYYYMMDD o ISO a un formato legible en español
function formatDateReadable(raw: string): string {
  if (!raw || raw === 'N/A') return 'N/A';
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    if (!isNaN(d.getTime()))
      return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  const d = new Date(raw);
  if (!isNaN(d.getTime()))
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  return raw;
}

// COMPONENTE PRINCIPAL
export function RiskAnalysisScreen({
  sessionId, patientData, source, savedAnalysis, onBackToLoad, onGoToEditor,
}: Props) {

  // Estados relacionados con las vistas ortogonales
  const [axialSlice,   setAxialSlice]   = useState(0);
  const [sagitalSlice, setSagitalSlice] = useState(0);
  const [coronalSlice, setCoronalSlice] = useState(0);
  const [images,       setImages]       = useState<any>({});
  const [dimensions,   setDimensions]   = useState({ x:100, y:100, z:100 });

  // Estados compartidos entre vistas
  const [sharedZoom,     setSharedZoom]     = useState(1.0);
  const [sharedContrast, setSharedContrast] = useState(100);
  const [pans, setPans] = useState({ a:{x:0,y:0}, s:{x:0,y:0}, c:{x:0,y:0} });
  const [axialCross,   setAxialCross]   = useState({ x:0.5, y:0.5 });
  const [sagitalCross, setSagitalCross] = useState({ x:0.5, y:0.5 });
  const [coronalCross, setCoronalCross] = useState({ x:0.5, y:0.5 });
  const [expandedView, setExpandedView] = useState<string|null>(null);

  // Estados relacionados con el análisis radiómico
  const [analysisStatus, setAnalysisStatus] = useState<'loading'|'done'|'error'>(
    savedAnalysis ? 'done' : 'loading'
  );
  const [analysis,      setAnalysis]      = useState<AnalysisResult|null>(savedAnalysis ?? null);
  const [analysisError, setAnalysisError] = useState('');
  const [saveStatus,    setSaveStatus]    = useState<'idle'|'saving'|'done'|'error'>('idle');

  // Refs para controlar inicializaciones y abortos de fetchs
  const initDone    = useRef(false);
  const abortRef    = useRef<AbortController|null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const prevSid     = useRef<string|null>(null);
  const DEBOUNCE_MS = 10;

  if (prevSid.current !== sessionId) {
    prevSid.current  = sessionId;
    initDone.current = false;
  }

//--------------------------------------------------------------------------------------------------------------------------------

//--------------------------------------------------------------------------------------------------------------------------------
// USE EFFECTS
// Carga de vistas ortogonales 
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
        setImages(data);
        if (data.dimensions && !initDone.current) {
          const d = data.dimensions;
          setDimensions(d);
          const az  = Math.floor(d.z/2);
          const sx_ = Math.floor(d.x/2);
          const cy_ = Math.floor(d.y/2);
          setAxialSlice(az); setSagitalSlice(sx_); setCoronalSlice(cy_);
          setAxialCross({   x: sx_/Math.max(1,d.x-1), y: cy_/Math.max(1,d.y-1) });
          setSagitalCross({ x: cy_/Math.max(1,d.y-1), y: 1-az/Math.max(1,d.z-1) });
          setCoronalCross({ x: sx_/Math.max(1,d.x-1), y: 1-az/Math.max(1,d.z-1) });
          initDone.current = true;
        } else if (data.dimensions) {
          setDimensions(data.dimensions);
        }
        fetch(
          `http://localhost:8000/api/prefetch/${sessionId}/${axialSlice}/${sagitalSlice}/${coronalSlice}`,
          { signal: ctrl.signal }
        ).catch(() => {});
      } catch (e:any) { if (e.name !== 'AbortError') console.error(e); }
    }, DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [sessionId, axialSlice, sagitalSlice, coronalSlice]);

  // Análisis de radiómica 
  useEffect(() => {
    if (!sessionId || savedAnalysis !== undefined) return;
    setAnalysisStatus('loading');
    fetch(`http://localhost:8000/api/analyze-tumor/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success === false) {
          setAnalysisError(d.detail || d.error || 'Error desconocido');
          setAnalysisStatus('error');
        } else {
          setAnalysis(d.analysis ?? d);
          setAnalysisStatus('done');
        }
      })
      .catch(e => { setAnalysisError(String(e)); setAnalysisStatus('error'); });
  }, [sessionId]);

  //--------------------------------------------------------------------------------------------------------------------------------

  //--------------------------------------------------------------------------------------------------------------------------------
  // USE CALLBACKS
  // Crosshair 
  const handleAxialCrossMove = useCallback((pos:{x:number;y:number}) => {
    setAxialCross(pos);
    const ns = Math.round(pos.x*(dimensions.x-1));
    const nc = Math.round(pos.y*(dimensions.y-1));
    setSagitalSlice(ns); setCoronalSlice(nc);
    setSagitalCross(p => ({ ...p, x: pos.y }));
    setCoronalCross(p => ({ ...p, x: ns/Math.max(1,dimensions.x-1) }));
  }, [dimensions]);

  const handleSagitalCrossMove = useCallback((pos:{x:number;y:number}) => {
    setSagitalCross(pos);
    const nc = Math.round(pos.x*(dimensions.y-1));
    const na = Math.round((1-pos.y)*(dimensions.z-1));
    setCoronalSlice(nc); setAxialSlice(na);
    setAxialCross(p => ({ ...p, y: nc/Math.max(1,dimensions.y-1) }));
    setCoronalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);

  const handleCoronalCrossMove = useCallback((pos:{x:number;y:number}) => {
    setCoronalCross(pos);
    const ns = Math.round(pos.x*(dimensions.x-1));
    const na = Math.round((1-pos.y)*(dimensions.z-1));
    setSagitalSlice(ns); setAxialSlice(na);
    setAxialCross(p => ({ ...p, x: ns/Math.max(1,dimensions.x-1) }));
    setSagitalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);

  // Toggle para vista expandida
  const toggleExpand = (v:string) => setExpandedView(expandedView === v ? null : v);
  const common = { sharedZoom, onZoomChange:setSharedZoom, sharedContrast, onContrastChange:setSharedContrast };

  const views = [
    { id:'axial',   title:'AXIAL',   slice:axialSlice,   maxS:dimensions.z, set:setAxialSlice,
      src:images.axial,   mask:images.axial_mask,   pan:pans.a, setPan:(p:any)=>setPans(v=>({...v,a:p})), cross:axialCross,   oc:handleAxialCrossMove },
    { id:'sagital', title:'SAGITAL', slice:sagitalSlice, maxS:dimensions.x, set:setSagitalSlice,
      src:images.sagital, mask:images.sagital_mask, pan:pans.s, setPan:(p:any)=>setPans(v=>({...v,s:p})), cross:sagitalCross, oc:handleSagitalCrossMove },
    { id:'coronal', title:'CORONAL', slice:coronalSlice, maxS:dimensions.y, set:setCoronalSlice,
      src:images.coronal, mask:images.coronal_mask, pan:pans.c, setPan:(p:any)=>setPans(v=>({...v,c:p})), cross:coronalCross, oc:handleCoronalCrossMove },
  ] as const;

  // Estilos de hover para los paneles de vistas 
  const viewPanelHover = {
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) =>
      (e.currentTarget.style.borderColor = 'rgba(255,207,38,.6)'),
    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) =>
      (e.currentTarget.style.borderColor = '#374151'),
  };
//--------------------------------------------------------------------------------------------------------------------------------

//--------------------------------------------------------------------------------------------------------------------------------
// INFORME HTML
  const buildReportHtml = useCallback((): string | null => {
    if (!analysis) return null;
    const isCCR_ = !analysis.isBenign;
    const pCCR   = analysis.probabilidad;
    const pOnco  = (100-pCCR).toFixed(1);
    const fechaLegible = formatDateReadable(patientData.fechaAdquisicion);
    const colorDx_ = isCCR_ ? '#fb923c' : '#2dd4bf';

    const imgAxial   = images.axial        ?? '';
    const imgAxMask  = images.axial_mask   ?? '';
    const imgSag     = images.sagital      ?? '';
    const imgSagMask = images.sagital_mask ?? '';
    const imgCor     = images.coronal      ?? '';
    const imgCorMask = images.coronal_mask ?? '';
    const hasImages  = !!(imgAxial || imgSag || imgCor);

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Informe — ${patientData.id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;min-height:100vh;font-family:Arial,sans-serif;background:#111;color:#ddd;padding:clamp(12px,3vw,32px)}
.container{max-width:960px;margin:0 auto;width:100%}
h1{color:#ffcf26;font-size:clamp(.9rem,2.5vw,1.2rem);border-bottom:1px solid #444;padding-bottom:8px;margin-bottom:12px}
.meta{color:#666;font-size:clamp(.6rem,1.5vw,.75rem);margin-bottom:16px;line-height:1.6}
.meta strong{color:#ccc}
h2{color:#aaa;font-size:clamp(.6rem,1.5vw,.75rem);text-transform:uppercase;letter-spacing:2px;margin:16px 0 8px}
.views{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(4px,1vw,12px);margin-bottom:16px}
@media(max-width:540px){.views{grid-template-columns:1fr}}
.view{background:#000;border:1px solid #333;border-radius:4px;overflow:hidden}
.view-label{color:#ffcf26;font-size:clamp(.5rem,1.2vw,.65rem);padding:3px 6px;font-family:monospace;letter-spacing:1px;background:#0a0a0a}
.vw{position:relative;width:100%;line-height:0}
.vw img.ct{width:100%;height:auto;display:block}
.vw img.mk{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:.7}
.diag{border:2px solid ${colorDx_};border-radius:6px;padding:clamp(8px,2vw,14px);text-align:center;margin-bottom:12px}
.dn{color:${colorDx_};font-size:clamp(.9rem,2.5vw,1.1rem);font-weight:700;margin-bottom:8px}
.bar-wrap{height:14px;background:#1a1a1a;border-radius:999px;overflow:hidden;position:relative;margin:8px 0 4px}
.bar-bg-l{position:absolute;left:0;top:0;height:100%;width:50%;background:#14532d}
.bar-bg-r{position:absolute;right:0;top:0;height:100%;width:50%;background:#431407}
.bar-fill{position:absolute;left:0;top:0;height:100%;border-radius:999px;background:linear-gradient(to right,#22c55e,#f97316);width:${pCCR}%}
.bar-mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.4);z-index:2}
.bar-labels{display:flex;justify-content:space-between;font-size:clamp(.6rem,1.5vw,.7rem);margin-top:4px;font-family:monospace}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(4px,1vw,8px);margin-bottom:12px}
@media(max-width:420px){.metrics{grid-template-columns:repeat(2,1fr)}}
.cell{background:#1a1a1a;border-radius:4px;padding:clamp(4px,1.2vw,8px)}
.lbl{color:#666;font-size:clamp(.55rem,1.2vw,.65rem);margin-bottom:2px}
.val{color:#fff;font-size:clamp(.7rem,1.8vw,.85rem);font-weight:600;font-family:monospace}
.feat{display:flex;justify-content:space-between;background:#1a1a1a;border-radius:3px;padding:3px 8px;margin-bottom:2px;font-size:clamp(.55rem,1.2vw,.65rem);font-family:monospace;gap:12px}
.feat-k{color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feat-v{color:#ffcf26;white-space:nowrap;font-weight:700}
footer{margin-top:20px;color:#444;font-size:clamp(.55rem,1.2vw,.65rem);border-top:1px solid #333;padding-top:8px;line-height:1.6}
</style></head><body>
<div class="container">
<h1>Informe de Análisis Renal</h1>
<p class="meta">
  Paciente: <strong>${patientData.nombre}</strong> &nbsp;·&nbsp;
  ID: <strong>${patientData.id}</strong> &nbsp;·&nbsp;
  Adquisición: ${fechaLegible} &nbsp;·&nbsp;
  Generado: ${new Date().toLocaleString('es-ES')}
</p>
${hasImages ? `
<h2>Vistas radiológicas</h2>
<div class="views">
  <div class="view"><div class="view-label">AXIAL</div>
    <div class="vw"><img class="ct" src="${imgAxial}" alt="axial"/>${imgAxMask?`<img class="mk" src="${imgAxMask}" alt="máscara axial"/>`:''}
    </div></div>
  <div class="view"><div class="view-label">SAGITAL</div>
    <div class="vw"><img class="ct" src="${imgSag}" alt="sagital"/>${imgSagMask?`<img class="mk" src="${imgSagMask}" alt="máscara sagital"/>`:''}
    </div></div>
  <div class="view"><div class="view-label">CORONAL</div>
    <div class="vw"><img class="ct" src="${imgCor}" alt="coronal"/>${imgCorMask?`<img class="mk" src="${imgCorMask}" alt="máscara coronal"/>`:''}
    </div></div>
</div>` : ''}
<h2>Diagnóstico</h2>
<div class="diag">
  <div class="dn">${analysis.diagnostico}</div>
  <div class="bar-wrap">
    <div class="bar-bg-l"></div><div class="bar-bg-r"></div>
    <div class="bar-fill"></div><div class="bar-mid"></div>
  </div>
  <div class="bar-labels">
    <span style="color:${!isCCR_?'#2dd4bf':'#6b7280'};font-weight:${!isCCR_?700:400}">${pOnco}% Oncocitoma</span>
    <span style="color:${isCCR_?'#fb923c':'#6b7280'};font-weight:${isCCR_?700:400}">${pCCR}% CCR</span>
  </div>
</div>
<h2>Métricas morfológicas</h2>
<div class="metrics">
  <div class="cell"><div class="lbl">Volumen</div><div class="val">${analysis.metricas.volumen} cm³</div></div>
  <div class="cell"><div class="lbl">Diámetro máximo</div><div class="val">${analysis.metricas.diametroMaximo} cm</div></div>
</div>
${Object.keys(analysis.radiomicsHighlight).length > 0 ? `
<h2>Features radiómicas clave</h2>
${Object.entries(analysis.radiomicsHighlight).map(([k,v])=>`
<div class="feat"><span class="feat-k">${k}</span><span class="feat-v">${v}</span></div>`).join('')}` : ''}
<footer>
  Segmentación: ${source==='editor'?'editada manualmente':'automática'} &nbsp;·&nbsp;
  Método clasificación: ${analysis.source==='model'?'GradientBoosting (modelo entrenado)':'Heurística morfológica'}
</footer>
</div>
</body></html>`;
  }, [analysis, patientData, images, source]);

  // Abrir informe 
  const handleOpenReport = useCallback(async () => {
    const html = buildReportHtml();
    if (!html) return;
    try {
      const res = await fetch('http://localhost:8000/api/open-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, patient_id: patientData.id }),
      });
      const data = await res.json();
      if (data.success) return;
    } catch (_) {}
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }, [buildReportHtml, patientData.id]);

  //--------------------------------------------------------------------------------------------------------------------------------

  //--------------------------------------------------------------------------------------------------------------------------------
  // Guardar en BD 
  const handleSave = useCallback(async () => {
    if (!analysis) return;
    const html = buildReportHtml();
    if (!html) return;
    setSaveStatus('saving');
    try {
      const res = await fetch('http://localhost:8000/api/save-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id:       patientData.id,
          session_id:       sessionId,
          report_html:      html,
          source,
          patient_name:     patientData.nombre,
          patient_sex:      patientData.sexo,
          acquisition_date: patientData.fechaAdquisicion,
          analysis_result:  analysis,
        }),
      });
      const data = await res.json();
      setSaveStatus(data.success ? 'done' : 'error');
    } catch (err) {
      console.error('Error al guardar:', err);
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 4000);
  }, [analysis, buildReportHtml, patientData, sessionId, source]);

  //--------------------------------------------------------------------------------------------------------------------------------

  //--------------------------------------------------------------------------------------------------------------------------------
  // Derivados de análisis 
  const isCCR        = analysis ? !analysis.isBenign : false;
  const probCCR      = analysis?.probabilidad ?? 0;
  const probOnco     = analysis ? parseFloat((100-probCCR).toFixed(1)) : 0;
  const colorBenigno = '#2dd4bf';
  const colorMaligno = '#fb923c';
  const colorDx      = isCCR ? colorMaligno : colorBenigno;
  const borderDx     = isCCR ? 'rgba(251,146,60,.4)' : 'rgba(45,212,191,.4)';

  //--------------------------------------------------------------------------------------------------------------------------------

  //--------------------------------------------------------------------------------------------------------------------------------
  //RENDERIZADO 
  return (
    <div className="flex flex-col h-screen w-full bg-black overflow-hidden text-white">

      {/* Header */}
      <div className="flex-shrink-0 bg-black border-b border-gray-700 p-2">
        <PatientInfo data={patientData}/>
      </div>

      {/* Vista expandida (overlay fullscreen) */}
      {expandedView && (
        <div className="fixed inset-0 z-50 bg-black/[.95]" onDoubleClick={() => setExpandedView(null)}>
          <div className="w-full h-full p-4">
            {expandedView==='axial'   && <ImageViewer title="AXIAL"   view="axial"   slice={axialSlice}   maxSlices={dimensions.z} onSliceChange={setAxialSlice}   imageSrc={images.axial}   maskSrc={images.axial_mask}   panPosition={pans.a} onPanChange={p=>setPans(v=>({...v,a:p}))} crosshairPos={axialCross}   onCrosshairMove={handleAxialCrossMove}   {...common}/>}
            {expandedView==='sagital' && <ImageViewer title="SAGITAL" view="sagital" slice={sagitalSlice} maxSlices={dimensions.x} onSliceChange={setSagitalSlice} imageSrc={images.sagital} maskSrc={images.sagital_mask} panPosition={pans.s} onPanChange={p=>setPans(v=>({...v,s:p}))} crosshairPos={sagitalCross} onCrosshairMove={handleSagitalCrossMove} {...common}/>}
            {expandedView==='coronal' && <ImageViewer title="CORONAL" view="coronal" slice={coronalSlice} maxSlices={dimensions.y} onSliceChange={setCoronalSlice} imageSrc={images.coronal} maskSrc={images.coronal_mask} panPosition={pans.c} onPanChange={p=>setPans(v=>({...v,c:p}))} crosshairPos={coronalCross} onCrosshairMove={handleCoronalCrossMove} {...common}/>}
            {expandedView==='3d'      && <TumorViewer3D sessionId={sessionId} refreshKey={0}/>}
          </div>
        </div>
      )}

      {/* Contenido principal */}
      <div className="flex-1 flex flex-col gap-1 p-1 overflow-hidden min-h-0">

        {/* Fila de vistas ortogonales — 38% de la altura disponible */}
        <div className="min-h-0 grid grid-cols-3 gap-1" style={{height:'38%'}}>
          {views.map(v => (
            <div key={v.id}
              className="bg-black min-h-0 overflow-hidden"
              style={{border:'1px solid #374151'}}
              {...viewPanelHover}>
              <ImageViewer
                title={v.title} view={v.id as any}
                slice={v.slice} maxSlices={v.maxS} onSliceChange={v.set}
                imageSrc={v.src} maskSrc={v.mask}
                panPosition={v.pan} onPanChange={v.setPan}
                crosshairPos={v.cross} onCrosshairMove={v.oc}
                onDoubleClick={() => toggleExpand(v.id)}
                {...common}
              />
            </div>
          ))}
        </div>

        {/* Fila inferior — visor 3D + panel de análisis */}
        <div className="flex-1 grid grid-cols-2 gap-1 min-h-0">

          {/* Visor 3D */}
          <div
            className="bg-black min-h-0 overflow-hidden"
            style={{border:'1px solid #374151'}}
            {...viewPanelHover}
            onDoubleClick={() => toggleExpand('3d')}>
            <TumorViewer3D sessionId={sessionId} refreshKey={0}/>
          </div>

          {/* Panel de análisis */}
          <div className="bg-black flex flex-col min-h-0" style={{border:'1px solid #374151'}}>

            {/* Estado: cargando */}
            {analysisStatus === 'loading' && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
                <Loader2 className="w-8 h-8" style={{color:'#ffcf26', animation:'spin 1s linear infinite'}}/>
                <p className="text-gray-400 text-sm">Ejecutando análisis radiómico...</p>
              </div>
            )}

            {/* Estado: error — el botón lleva al editor para corregir la máscara */}
            {analysisStatus === 'error' && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
                <AlertCircle className="w-8 h-8 text-red-500"/>
                <p className="text-red-400 text-sm font-semibold">Error en el análisis</p>
                <p className="text-gray-500 text-xs text-center">{analysisError}</p>
                <button
                  onClick={onGoToEditor}
                  className="flex items-center gap-2 bg-transparent border border-[#2dd4bf] text-[#2dd4bf] hover:bg-[#2dd4bf]/10 px-4 py-1.5 rounded text-xs cursor-pointer active:scale-95">
                  <Pencil style={{width:12,height:12}}/>
                  Ir al editor de máscara
                </button>
              </div>
            )}

            {/* Estado: análisis completado */}
            {analysisStatus === 'done' && analysis && (
              <div className="flex-1 flex flex-col gap-1.5 p-2 overflow-y-auto min-h-0">

                {/* Cabecera del panel */}
                <div className="border-b border-gray-700 pb-1.5 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <FlaskConical style={{width:14,height:14,color:'#ffcf26'}}/>
                    <span className="text-gray-300 font-bold uppercase" style={{fontSize:11,letterSpacing:2}}>
                      Análisis de Radiómica
                    </span>
                  </div>
                  {source === 'saved' && (
                    <p className="text-gray-500 mt-0.5 italic" style={{fontSize:9}}>
                      Resultados guardados — no recalculados
                    </p>
                  )}
                </div>

                {/* Diagnóstico */}
                <div className="rounded-lg p-2" style={{background:'#000',border:`2px solid ${borderDx}`}}>
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    {analysis.isBenign
                      ? <CheckCircle style={{width:16,height:16,color:colorBenigno}}/>
                      : <AlertCircle style={{width:16,height:16,color:colorMaligno}}/>}
                    <span className="text-gray-400 font-bold uppercase" style={{fontSize:9,letterSpacing:2}}>
                      Diagnóstico
                    </span>
                  </div>
                  <p className="text-center text-sm font-semibold mb-2" style={{color:colorDx}}>
                    {analysis.diagnostico}
                  </p>

                  {/* Barra de probabilidad */}
                  <div>
                    <div className="flex justify-between mb-1" style={{fontSize:10}}>
                      <span style={{color:!isCCR?colorBenigno:'#4b5563', fontWeight:!isCCR?700:400}}>Oncocitoma</span>
                      <span style={{color:isCCR?colorMaligno:'#4b5563',  fontWeight:isCCR?700:400}}>CCR</span>
                    </div>
                    <div className="relative rounded-full overflow-hidden" style={{height:12}}>
                      <div className="absolute inset-0 flex">
                        <div className="flex-1" style={{background:'rgba(20,83,45,.7)'}}/>
                        <div className="flex-1" style={{background:'rgba(67,20,7,.7)'}}/>
                      </div>
                      <div
                        className="absolute left-0 top-0 h-full rounded-full"
                        style={{
                          width: `${probCCR}%`,
                          background: 'linear-gradient(to right,#16a34a,#ea580c)',
                          transition: 'width .7s ease',
                        }}
                      />
                      <div className="absolute top-0 bottom-0 w-px z-20" style={{left:'50%',background:'rgba(255,255,255,.5)'}}/>
                    </div>
                    <div className="flex justify-between mt-1 font-mono" style={{fontSize:11}}>
                      <span style={{color:!isCCR?colorBenigno:'#4b5563', fontWeight:!isCCR?700:400}}>{probOnco}%</span>
                      <span style={{color:isCCR?colorMaligno:'#4b5563',  fontWeight:isCCR?700:400}}>{probCCR}%</span>
                    </div>
                  </div>
                </div>

                {/* Métricas morfológicas */}
                <div className="rounded-lg p-1.5" style={{background:'#000',border:'1px solid #374151'}}>
                  <p className="text-gray-500 font-bold uppercase text-center mb-1.5" style={{fontSize:9,letterSpacing:2}}>
                    Métricas morfológicas
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {[
                      { label:'Volumen',       val:`${analysis.metricas.volumen} cm³` },
                      { label:'Diám. máximo',  val:`${analysis.metricas.diametroMaximo} cm` },
                    ].map(m => (
                      <div key={m.label} className="rounded p-1" style={{background:'#000',border:'1px solid #374151'}}>
                        <p className="text-gray-500 m-0" style={{fontSize:9}}>{m.label}</p>
                        <p className="text-white font-semibold font-mono m-0" style={{fontSize:12}}>{m.val}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Features radiómicas */}
                {Object.keys(analysis.radiomicsHighlight).length > 0 && (
                  <div className="rounded-lg p-1.5" style={{background:'#000',border:'1px solid #374151'}}>
                    <p className="text-gray-500 font-bold uppercase text-center mb-1" style={{fontSize:9,letterSpacing:2}}>
                      Features radiómicas clave
                    </p>
                    {Object.entries(analysis.radiomicsHighlight).map(([k,v]) => (
                      <div
                        key={k}
                        className="flex justify-between rounded mb-0.5 px-1.5 py-0.5"
                        style={{background:'#000',border:'1px solid #374151'}}>
                        <span className="text-gray-400 font-mono" style={{fontSize:9}}>{k}</span>
                        <span className="font-mono font-bold" style={{fontSize:9,color:'#ffcf26'}}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Botones de acción */}
                <div className="mt-auto pt-1 flex flex-col gap-1">
                  <button
                    onClick={handleOpenReport}
                    className="w-full flex items-center justify-center gap-1.5 bg-transparent text-[#2dd4bf] hover:bg-[#2dd4bf]/10 p-1.5 rounded text-xs cursor-pointer active:scale-95"
                    style={{border:'1px solid rgba(45,212,191,0.6)'}}>
                    <ExternalLink style={{width:12,height:12}}/>
                    Generar y ver informe
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saveStatus === 'saving'}
                    className={`w-full flex items-center justify-center gap-1.5 bg-transparent p-1.5 rounded text-xs active:scale-95
                      ${saveStatus === 'saving'
                        ? 'opacity-50 cursor-not-allowed text-gray-500'
                        : 'cursor-pointer hover:bg-[#ffcf26]/10'}`}
                    style={{
                      color: saveStatus === 'saving' ? '#6b7280' : '#ffcf26',
                      border: saveStatus === 'saving' ? '1px solid #4b5563' : '1px solid rgba(234,179,8,0.6)',
                    }}>
                    {saveStatus === 'saving' && <><Loader2 style={{width:12,height:12,animation:'spin 1s linear infinite'}}/>Guardando...</>}
                    {saveStatus === 'done'   && <><CheckCircle style={{width:12,height:12}}/>Guardado</>}
                    {saveStatus === 'error'  && <><AlertCircle style={{width:12,height:12,color:'#f87171'}}/>Error al guardar</>}
                    {saveStatus === 'idle'   && <><Save style={{width:12,height:12}}/>Guardar análisis completo</>}
                  </button>
                  <button
                    onClick={onBackToLoad}
                    className="w-full flex items-center justify-center gap-1.5 bg-transparent border border-gray-700 text-gray-400 hover:bg-[#6b7280]/10 p-1.5 rounded text-xs cursor-pointer active:scale-95">
                    <Home style={{width:12,height:12}}/>
                    Pantalla principal
                  </button>
                </div>

              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
//--------------------------------------------------------------------------------------------------------------------------------