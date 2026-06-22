import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Edit, ArrowRight, Home, ChevronLeft, ChevronRight, Loader2, AlertTriangle } from 'lucide-react';
import { Button }        from './ui/button';
import { PatientInfo }   from './PatientInfo';
import { ImageViewer }   from './ImageViewer';
import { TumorViewer3D } from './TumorViewer3D';

//----------------------------------------------------------------------------------------------------------------------------------
// COMPONENTE PRINCIPAL: VISUALIZADOR DE IMÁGENES Y CONTROL DE FLUJOS
export function ViewerScreen({
  sessionId,           // ID de sesión para cargar las imágenes y datos del paciente
  patientData,         // Datos del paciente para mostrar en la cabecera
  onEditMask,          // Función para ir al editor de máscaras
  onContinue,          // Función para continuar al siguiente paso (análisis), SOLO si la segmentación ha sido aplicada por el usuario
  onBackToLoad         // Función para volver a la pantalla de carga
}: any) {
  const [axialSlice, setAxialSlice] = useState(0);                // Slice actual para vista axial
  const [sagitalSlice, setSagitalSlice] = useState(0);            // Slice actual para vista sagital 
  const [coronalSlice, setCoronalSlice] = useState(0);            // Slice actual para vista coronal
  const [images, setImages] = useState<any>({});                  // Contiene: axial, axial_mask, sagital, sagital_mask, coronal, coronal_mask
  const [dimensions, setDimensions] = useState({ x: 100, y: 100, z: 100 });       
  
  // Estados para controles compartidos
  const [sharedZoom, setSharedZoom] = useState(1.0);
  const [pans, setPans] = useState({ a:{x:0,y:0}, s:{x:0,y:0}, c:{x:0,y:0} });
  const [sharedContrast, setSharedContrast] = useState(100);

  // Estados para posición de crosshair (valores entre 0 y 1, relativos a la vista)
  const [axialCross, setAxialCross] = useState({ x: 0.5, y: 0.5 });
  const [sagitalCross, setSagitalCross] = useState({ x: 0.5, y: 0.5 });
  const [coronalCross, setCoronalCross] = useState({ x: 0.5, y: 0.5 });

  // Estados para control de panel lateral y vistas expandidas
  const [isPanelOpen, setIsPanelOpen]  = useState(false);
  const [expandedView, setExpandedView] = useState<string | null>(null);
  const [segStatus, setSegStatus] = useState<'idle'|'running'|'done'|'error'>('idle');
  const [showNoSegWarning, setShowNoSegWarning] = useState(false);
  
  // Estado para controlar si el usuario ha aplicado la segmentación manualmente
  const [userAppliedSegmentation, setUserAppliedSegmentation] = useState(false);
  
  const initDone = useRef(false);
  const abortRef = useRef<AbortController | null>(null); // cancela la petición HTTP anterior
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null); // evita saturar el backend al cambiar slices rápidamente
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null); // polling de inferencia
  
  const DEBOUNCE_MS = 10;  // Tiempo de debounce para la carga de imágenes al cambiar slices (en ms). Evita saturar el backend
  // viewRefreshKey se incrementa al terminar la segmentación para forzar recarga de vistas
  const [viewRefreshKey, setViewRefreshKey] = useState(0);
  
  const toggleExpand = (v: string) => setExpandedView(expandedView === v ? null : v);
  const isContinueEnabled = userAppliedSegmentation && segStatus === 'done';
  const commonProps = {
    sharedZoom, onZoomChange: setSharedZoom,
    sharedContrast, onContrastChange: setSharedContrast,
  };
 
  //-----------------------------------------------------------------------------------------------------------------------------------

  //-----------------------------------------------------------------------------------------------------------------------------------
  // EFECTO PRINCIPAL: CARGA DE IMÁGENES Y DATOS AL CAMBIAR SLICE O SESIÓN
  useEffect(() => {
    if (!sessionId) return;

    // Debounce para evitar múltiples cargas rápidas al cambiar slices
    if (debounceRef.current) clearTimeout(debounceRef.current);
    
    debounceRef.current = setTimeout(async () => {
      // Abortar cualquier solicitud anterior si aún está en curso
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
        
        // Si es la primera carga con dimensiones, inicializar los slices y crosshairs en el centro
        if (data.dimensions && !initDone.current) {
          const d = data.dimensions;
          setDimensions(d);

          // Inicializar en el centro de la imagen
          const az = Math.floor(d.z / 2);
          const sx = Math.floor(d.x / 2);
          const cy = Math.floor(d.y / 2);

          setAxialSlice(az); 
          setSagitalSlice(sx); 
          setCoronalSlice(cy);

          // Posicionar crosshairs en el centro relativo de cada vista
          setAxialCross({ x: sx / Math.max(1, d.x-1), y: cy / Math.max(1, d.y-1) });
          setSagitalCross({ x: cy / Math.max(1, d.y-1), y: 1 - az / Math.max(1, d.z-1) });
          setCoronalCross({ x: sx / Math.max(1, d.x-1), y: 1 - az / Math.max(1, d.z-1) });

          initDone.current = true;

        } else if (data.dimensions) {
          setDimensions(data.dimensions);
        }
      } catch (e: any) { if (e.name !== 'AbortError') console.error(e); }
    }, DEBOUNCE_MS);

    // Cleanup: solo cancelar debounce y request en vuelo
    // IMPORTANTE: NO matar el pollRef aquí — el polling de inferencia debe sobrevivir
    // a los cambios de slice. Su cleanup está en el useEffect dedicado de abajo.
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [sessionId, axialSlice, sagitalSlice, coronalSlice, viewRefreshKey]);

//------------------------------------------------------------------------------------------------------------------------------------

//------------------------------------------------------------------------------------------------------------------------------------
// CLEANUP DEDICADO DEL POLLING: Se ejecuta solo al desmontar el componente, no en cada cambio de slice.
// Separarlo del useEffect de vistas evita que el intervalo se cancele cada vez que el usuario navega.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []); 

//------------------------------------------------------------------------------------------------------------------------------------

//-----------------------------------------------------------------------------------------------------------------------------------
// FUNCIONES DE CONTROL DE CROSSHAIRS: Sincronizan el movimiento del crosshair con el cambio de slices y entre vistas
  const handleAxialCrossMove = useCallback((pos: {x:number;y:number}) => {
    setAxialCross(pos);

    //La X del crosshair axial = slice sagital
    const newSag = Math.round(pos.x * (dimensions.x-1));
    //La Y del crosshair axial = slice coronal
    const newCor = Math.round(pos.y * (dimensions.y-1));

    setSagitalSlice(newSag); 
    setCoronalSlice(newCor);

    // Actualizar posición de crosshairs en las otras vistas
    setSagitalCross(p => ({ ...p, x: pos.y }));
    setCoronalCross(p => ({ ...p, x: newSag / Math.max(1, dimensions.x-1) }));
  }, [dimensions]);


  const handleSagitalCrossMove = useCallback((pos: {x:number;y:number}) => {
    setSagitalCross(pos);

    // La X del crosshair sagital = slice coronal
    const newCor = Math.round(pos.x * (dimensions.y-1));
    // La Y del crosshair sagital = slice axial (invertida)
    const newAx  = Math.round((1-pos.y) * (dimensions.z-1));

    setCoronalSlice(newCor); 
    setAxialSlice(newAx);

    // Actualizar posición de crosshairs en las otras vistas
    setAxialCross(p  => ({ ...p, y: newCor / Math.max(1, dimensions.y-1) }));
    setCoronalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);


  const handleCoronalCrossMove = useCallback((pos: {x:number;y:number}) => {
    setCoronalCross(pos);

    // La X del crosshair coronal = slice sagital
    const newSag = Math.round(pos.x * (dimensions.x-1));
    // La Y del crosshair coronal = slice axial (invertida)
    const newAx  = Math.round((1-pos.y) * (dimensions.z-1));

    setSagitalSlice(newSag); 
    setAxialSlice(newAx);

    // Actualizar posición de crosshairs en las otras vistas
    setAxialCross(p   => ({ ...p, x: newSag / Math.max(1, dimensions.x-1) }));
    setSagitalCross(p => ({ ...p, y: pos.y }));
  }, [dimensions]);

//------------------------------------------------------------------------------------------------------------------------------------

//------------------------------------------------------------------------------------------------------------------------------------
// SEGMENTACIÓN AUTOMÁTICA: Controla la ejecución de la segmentación automática, el estado de la operación y la validación para continuar al análisis

  const handleSegmentation = async () => {
    setSegStatus('running');
    setShowNoSegWarning(false);
    if (pollRef.current) clearInterval(pollRef.current);

    try {
      // El endpoint responde inmediatamente lanzando la inferencia en background
      const res = await fetch(`http://localhost:8000/api/run-inference/${sessionId}`,
        { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setSegStatus('error');
        console.error('[ViewerScreen] Error al lanzar inferencia:', data);
        return;
      }

      // Polling cada 4s hasta que el backend confirme 'done' o 'error'
      pollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`http://localhost:8000/api/inference-status/${sessionId}`);
          const sd = await sr.json();

          if (sd.status === 'done') {
            clearInterval(pollRef.current!); pollRef.current = null;
            setSegStatus('done');
            setUserAppliedSegmentation(true);
            // Refrescar vistas SIN resetear initDone (evita el bug de setSegStatus('idle'))
            setViewRefreshKey(k => k + 1);
            console.log('[ViewerScreen] Segmentación completada:', sd);

          } else if (sd.status === 'error') {
            clearInterval(pollRef.current!); pollRef.current = null;
            setSegStatus('error');
            console.error('[ViewerScreen] Error en inferencia:', sd.error);
          }
        } catch (pollErr) {
          console.warn('[ViewerScreen] Error de red en polling (reintentando):', pollErr);
        }
      }, 4000);

    } catch {
      setSegStatus('error');
      console.error('[ViewerScreen] Error de conexión al lanzar inferencia');
    }
  };


  // Función para continuar - valida que el usuario haya aplicado la segmentación
  const handleContinue = () => {
    // Verificar si el usuario ha aplicado la segmentación manualmente
    if (!userAppliedSegmentation) {
      setShowNoSegWarning(true);
      console.warn(`[ViewerScreen] Intento de continuar sin segmentación aplicada por el usuario. userAppliedSegmentation: ${userAppliedSegmentation}, segStatus: ${segStatus}`);
      return; // ← NO NAVEGA
    }
    setShowNoSegWarning(false);
    onContinue?.({ sessionId, source: 'viewer' });
  };

  // Ir al editor
  const handleEditMask = () => {
    onEditMask();
  };
//------------------------------------------------------------------------------------------------------------------------------------

//------------------------------------------------------------------------------------------------------------------------------------
// KEY PARA RE-RENDERIZAR EL VISOR 3D: Se actualiza cada vez que cambia la sesión para forzar que el componente TumorViewer3D se reinicie y cargue la nueva segmentación
const memoized3DViewer = useMemo(() => (
  <TumorViewer3D
    sessionId={sessionId}
    refreshKey={viewRefreshKey}
    showEmptyState={!userAppliedSegmentation || segStatus !== 'done'}
  />
), [sessionId, userAppliedSegmentation, segStatus, viewRefreshKey]);
//-------------------------------------------------------------------------------------------------------------------------------------

//------------------------------------------------------------------------------------------------------------------------------------
// RENDERIZADO PRINCIPAL

  return (
    <div className="h-screen w-full bg-gray-200 flex flex-col overflow-hidden">
      <div className="bg-black border-b border-gray-600 p-3 flex-shrink-0">
        <PatientInfo data={patientData} />
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        <div
          className={`grid gap-1 p-1 bg-black transition-all duration-300
            ${expandedView ? 'grid-cols-1 grid-rows-1' : 'grid-cols-2 grid-rows-2'}`}
          style={{ width: isPanelOpen ? 'calc(100% - 320px)' : '100%' }}
        >
          {(!expandedView || expandedView === 'axial') && (
            <div className="bg-black border border-gray-600 min-h-0 hover:border-[#ffcf26] transition-colors">
              <ImageViewer
                title="VISTA AXIAL" view="axial"
                slice={axialSlice} maxSlices={dimensions.z} onSliceChange={setAxialSlice}
                imageSrc={images.axial} maskSrc={images.axial_mask}
                panPosition={pans.a} onPanChange={p => setPans({ ...pans, a: p })}
                crosshairPos={axialCross} onCrosshairMove={handleAxialCrossMove}
                onDoubleClick={() => toggleExpand('axial')}
                {...commonProps}
              />
            </div>
          )}
          {(!expandedView || expandedView === 'sagital') && (
            <div className="bg-black border border-gray-600 min-h-0 hover:border-[#ffcf26] transition-colors">
              <ImageViewer
                title="VISTA SAGITAL" view="sagital"
                slice={sagitalSlice} maxSlices={dimensions.x} onSliceChange={setSagitalSlice}
                imageSrc={images.sagital} maskSrc={images.sagital_mask}
                panPosition={pans.s} onPanChange={p => setPans({ ...pans, s: p })}
                crosshairPos={sagitalCross} onCrosshairMove={handleSagitalCrossMove}
                onDoubleClick={() => toggleExpand('sagital')}
                {...commonProps}
              />
            </div>
          )}
          {(!expandedView || expandedView === 'coronal') && (
            <div className="bg-black border border-gray-600 min-h-0 hover:border-[#ffcf26] transition-colors">
              <ImageViewer
                title="VISTA CORONAL" view="coronal"
                slice={coronalSlice} maxSlices={dimensions.y} onSliceChange={setCoronalSlice}
                imageSrc={images.coronal} maskSrc={images.coronal_mask}
                panPosition={pans.c} onPanChange={p => setPans({ ...pans, c: p })}
                crosshairPos={coronalCross} onCrosshairMove={handleCoronalCrossMove}
                onDoubleClick={() => toggleExpand('coronal')}
                {...commonProps}
              />
            </div>
          )}
          {(!expandedView || expandedView === '3d') && (
            <div className="bg-[#b3caec] border border-gray-600 min-h-0">
              {memoized3DViewer}
            </div>
          )}
        </div>

        {/* Panel lateral */}
        <div className="flex-shrink-0 bg-black border-l border-gray-600 flex transition-all duration-300 overflow-hidden"
          style={{ width: isPanelOpen ? '320px' : '0px' }}>
          <div className="w-80 flex flex-col p-4 gap-3">
            <div className="text-center border-b border-gray-600 pb-2">
              <h3 className="text-yellow-500 font-bold text-s">CONTROLES</h3>
            </div>

            <Button
              onClick={handleSegmentation}
              disabled={segStatus === 'running' || userAppliedSegmentation}
              className={`w-full h-10 text-sm border-2 transition-all
                ${(!userAppliedSegmentation && segStatus !== 'running')
                  ? 'bg-transparent hover:bg-[#ffcf26]/10 text-[#ffcf26] border-[#ffcf26]'
                  : 'bg-transparent text-gray-500 border-gray-600 cursor-not-allowed opacity-50'}`}
            >
              {segStatus === 'running' ? (
                <><Loader2 className="mr-2 w-4 h-4 animate-spin" />Segmentando...</>
              ) : userAppliedSegmentation ? (
                <>✓ Segmentación Automática Aplicada ✓</>
              ) : (
                <>Aplicar Segmentación Automática <ArrowRight className="ml-2 w-4 h-4" /></>
              )}
            </Button>

            {/* Mensaje de confirmación después de aplicar */}
            {userAppliedSegmentation && segStatus === 'done' && (
              <div className="bg-green-950/40 border border-green-700/50 rounded p-2 text-center">
                <p className="text-green-400 text-xs">
                  ✓ Segmentación automática aplicada correctamente
                </p>
              </div>
            )}

            {/* Botón: Editar máscara — activo antes y después de segmentar, bloqueado durante inferencia */}
            <Button onClick={handleEditMask}
              disabled={segStatus === 'running'}
              className={`w-full border-2 h-10 text-sm transition-all
                ${segStatus === 'running'
                  ? 'bg-transparent text-gray-500 border-gray-600 cursor-not-allowed opacity-50'
                  : 'bg-transparent hover:bg-[#2dd4bf]/10 text-[#2dd4bf] border-[#2dd4bf] cursor-pointer'}`}>
              <Edit className="mr-2 w-4 h-4" />Editar Máscara
            </Button>

            {/* Botón: Continuar — SOLO activo si el usuario aplicó la segmentación */}
            <div className="flex flex-col gap-2">
              <Button
                onClick={handleContinue}
                disabled={!isContinueEnabled}
                className={`w-full h-10 text-sm border-2 transition-all
                  ${isContinueEnabled
                    ? 'bg-transparent hover:bg-[#fb923c]/10 text-orange-500 border-orange-500 cursor-pointer'
                    : 'bg-transparent text-gray-500 border-gray-600 cursor-not-allowed opacity-50'}`}
              >
                {!isContinueEnabled ? (
                  <>  Segmentación Requerida</>
                ) : (
                  <>Continuar con Análisis <ArrowRight className="ml-2 w-4 h-4" /></>
                )}
              </Button>

              {/* Mensaje de advertencia cuando intenta continuar sin segmentación */}
              {showNoSegWarning && (
                <div className="bg-amber-500/15 border border-amber-500/50 rounded px-3 py-2 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-amber-300 text-[11px] leading-tight">
                    {segStatus === 'idle' && " Primero debes aplicar la Segmentación Automática."}
                    {segStatus === 'running' && " La segmentación aún se está procesando. Por favor, espera."}
                    {segStatus === 'error' && " Hubo un error en la segmentación. Por favor, inténtalo de nuevo."}
                  </p>
                </div>
              )}
              
              {/* Mensaje de advertencia persistente si no hay segmentación aplicada */}
              {!isContinueEnabled && segStatus !== 'running' && !showNoSegWarning && (
                <div className="bg-orange-950/40 border border-orange-700/50 rounded p-2 text-center">
                  <p className="text-orange-400 text-xs">
                     Aplica la segmentación automática para continuar con el análisis
                  </p>
                </div>
              )}
            </div>

            <div className="mt-auto pt-4 border-t border-gray-600">
              <Button onClick={onBackToLoad}
                className="w-full bg-transparent hover:bg-gray-600/20 text-gray-300 border-2 border-gray-500 h-10 text-sm">
                <Home className="mr-2 w-4 h-4" />Volver a Inicio
              </Button>
            </div>
          </div>
        </div>

        {/* Toggle panel */}
        <button
          onClick={() => setIsPanelOpen(!isPanelOpen)}
          className="absolute top-1/2 -translate-y-1/2 bg-black hover:bg-black text-[#ffcf26] border-l border-t border-b border-gray-600 transition-colors z-30 rounded-l-lg"
          style={{ right: isPanelOpen ? '320px' : '0px', transition: 'right 0.3s' }}
        >
          <div className="p-2">
            {isPanelOpen ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </div>
        </button>
      </div>
    </div>
  );
}