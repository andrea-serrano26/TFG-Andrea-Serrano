import { useState, useRef } from 'react';
import { Upload, Loader2, Search, X } from 'lucide-react';
import { Button } from './ui/button';
import { KidneyIllustration } from './KidneyIllustration';
import logoEtsit from './assets/logoetsit.png';
import logoRyC   from './assets/logoRyC.png';

//--------------------------------------------------------------------------------------------------------------------------------
// PROPS DEL COMPONENTE LoadScreen
// onLoadDicom: Función que se llama cuando se cargan los archivos DICOM exitosamente. 
// Recibe la información del paciente y el ID de sesión.
// onLoadSavedAnalysis: Función opcional que se llama cuando se recupera un análisis guardado exitosamente.
// Cuando el usuario carga/recupera un análisis, los componentes notifican al componente padre (App) 
// para que actualice su estado y muestre la información correspondiente.
//--------------------------------------------------------------------------------------------------------------------------------
interface LoadScreenProps {
  onLoadDicom: (data: any, sessionId: string) => void;
  onLoadSavedAnalysis?: (patientId: string) => void;
}

export function LoadScreen({ onLoadDicom, onLoadSavedAnalysis }: LoadScreenProps) {
  const [isUploading, setIsUploading] = useState(false);               //¿Subiendo archivos?
  const [showSearchDialog, setShowSearchDialog] = useState(false);     //¿Mostrar diálogo de búsqueda?
  const [searchPatientId, setSearchPatientId] = useState('');          //ID del paciente para búsqueda
  const [isSearching, setIsSearching] = useState(false);               //¿Realizando búsqueda en DB?
  const [searchError, setSearchError] = useState('');                  //Error al buscar análisis guardado
  
  const fileInputRef = useRef<HTMLInputElement>(null);                 //Referencia al input de archivos oculto
  const searchButtonRef = useRef<HTMLDivElement>(null);                //Referencia al botón de búsqueda para posicionar el diálogo

  //--------------------------------------------------------------------------------------------------------------------------------
  // MANEJO DE CARGA DE ARCHIVOS DICOM

  // Al hacer clic en el botón de cargar, se dispara el input de archivos oculto
    const handleButtonClick = () => {
      fileInputRef.current?.click();  
    };
  
  // Flujo de carga de archivos DICOM:
  // Usuario selecciona archivos .dcm
  // Se envían al backend (/api/upload-dicom)
  // Backend procesa y retorna session_id e info del paciente
  // Frontend llama a onLoadDicom para cambiar pantalla

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true); // Indica que se está subiendo para mostrar el loader y deshabilitar el botón
   
    const formData = new FormData();
    Array.from(files).forEach((file) => {
      formData.append('files', file); // El backend espera un campo 'files' con los archivos DICOM adjuntos
    });

    try {
      // POST a la API para procesar los archivos DICOM
      const response = await fetch('http://localhost:8000/api/upload-dicom', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (data.success) {
        onLoadDicom(data.patient_info, data.session_id); // Notifica al componente padre que los archivos se procesaron exitosamente.
      } else {
        alert('Error al procesar DICOM: ' + (data.error || 'Desconocido'));
      }
    } catch (error) {
      console.error("Error en la carga:", error);
      alert('Error de conexión con el servidor.');
    } finally {
      setIsUploading(false); // Oculta el loader y vuelve a habilitar el botón independientemente del resultado
    }
  };
  //---------------------------------------------------------------------------------------------------------------------------------
  
  //---------------------------------------------------------------------------------------------------------------------------------
  // MANEJO DE BÚSQUEDA DE ANÁLISIS GUARDADOS
 
  // Al hacer clic en el botón de búsqueda, se muestra un diálogo para ingresar el ID del paciente
  const handleOpenSearch = () => {
    setShowSearchDialog(true);
    setSearchError('');
    setSearchPatientId('');
  };

  // Flujo de búsqueda de análisis guardados:
  // Usuario ingresa ID del paciente y confirma búsqueda
  // Se hace una solicitud GET a /api/load-analysis-full/{patient_id}
  // Si se encuentra el análisis, se llama a onLoadSavedAnalysis con el ID del paciente
  // Si no se encuentra o hay un error, se muestra un mensaje de error en el diálogo

  const handleSearch = async () => {
    if (!searchPatientId.trim()) {
      setSearchError('Ingresa un ID de paciente');
      return;
    }
    setIsSearching(true);
    setSearchError('');

    try {
      // GET a la API para recuperar el análisis guardado por ID de paciente
      const res = await fetch(`http://localhost:8000/api/load-analysis-full/${searchPatientId.trim()}`);
      const data = await res.json();
      if (!data.success) {
        setSearchError(data.error || 'Análisis no encontrado');
        setIsSearching(false);
        return;
      }
      setShowSearchDialog(false);
      setSearchPatientId('');
      onLoadSavedAnalysis?.(searchPatientId.trim());
    } catch {
      setSearchError('Error de conexión con el servidor');
      setIsSearching(false);
    }
  };

  // Función para calcular la posición del diálogo de búsqueda basado en la posición del botón de búsqueda, 
  // para que aparezca cerca de él en lugar de centrado en la pantalla.
  const getDialogPosition = () => {
    if (!searchButtonRef.current) return { top: '50%', right: '50%' };
    const rect = searchButtonRef.current.getBoundingClientRect();
    return {
      top: `${rect.top + window.scrollY - 50}px`, 
      left: `${rect.right + 20}px`,
    };
  };

  const dialogPos = showSearchDialog ? getDialogPosition() : { top: '0', left: '0' };

  //---------------------------------------------------------------------------------------------------------------------------------
  
  //---------------------------------------------------------------------------------------------------------------------------------
  // RENDERIZADO DEL COMPONENTE
  return (
    <div className="relative h-screen w-full flex flex-col items-center justify-center bg-gradient-to-br from-black to-black">
      
      <input 
        type="file" 
        ref={fileInputRef}
        onChange={handleFileChange}
        multiple                                                 // Permite seleccionar múltiples archivos DICOM a la vez
        accept=".dcm"                                            // Solo permite seleccionar archivos con extensión .dcm
        style={{ 
          position: 'absolute', width: '1px', height: '1px',
          padding: 0, margin: '-1px', overflow: 'hidden',
          clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap',
          border: 0, opacity: 0, pointerEvents: 'none'
        }}
        className="sr-only"                                      // Oculto visualmente pero accesible para lectores de pantalla
      />

      {/* Logo ETSIT - esquina inferior izquierda */}
      <img
        src={logoEtsit}
        alt="ETSIT UPM"
        style={{ position: 'absolute', bottom: '16px', left: '24px', height: '70px' }}
      />

      {/* Logo Ramón y Cajal - esquina inferior derecha */}
      <img
        src={logoRyC}
        alt="Hospital Ramón y Cajal"
        style={{ position: 'absolute', bottom: '30px', right: '24px', height: '40px' }}
      />

      <div className="text-center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2rem', marginTop: '-2rem' }}>

        {/* Logotipo RenalSight — grande y arriba */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
          <h1 className="tracking-tight" style={{ fontSize: '5.5rem', lineHeight: 1.05, margin: 0 }}>
            <span style={{ fontWeight: 300, color: '#e8eaf0' }}>Renal</span>
            <span style={{ fontWeight: 700, color: '#2dd4bf' }}>Sight</span>
          </h1>
          <div style={{
            height: '1px',
            background: 'linear-gradient(to right, transparent, #2dd4bf55, transparent)',
            width: '360px',
          }} />
          <p style={{ color: '#6b7a99', letterSpacing: '0.22em', fontSize: '0.82rem', fontWeight: 400, margin: 0 }}>
            RENAL MASS ANALYSIS SYSTEM
          </p>
        </div>

        <div className="flex flex-col items-center gap-6">
          <KidneyIllustration />
          
          <Button
            onClick={handleButtonClick}
            disabled={isUploading}
            className="bg-transparent hover:bg-[#ffcf26]/10 text-[#ffcf26] border-2 border-[#ffcf26] px-8 py-6 text-lg shadow-lg shadow-[#ffcf26]/20 transition-all active:scale-95"
          >
            {isUploading ? (
              <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Procesando Archivos...</>
            ) : (
              <><Upload className="mr-2 h-5 w-5" />Cargar Archivos DICOM</>
            )}
          </Button>

          <div ref={searchButtonRef}>
            <Button
              onClick={handleOpenSearch}
              className="bg-transparent hover:bg-[#2dd4bf]/10 text-[#2dd4bf] border-2 border-[#2dd4bf] px-8 py-3 text-sm shadow-lg shadow-[#2dd4bf]/10 transition-all active:scale-95"
            >
              <Search className="mr-2 h-4 w-4" />
              Recuperar Análisis Anterior
            </Button>
          </div>
        </div>
      </div>

      {showSearchDialog && (
        <>
          <div 
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setShowSearchDialog(false)}
          />
          
          <div 
            className="fixed bg-black border border-gray-500 rounded-lg w-80 p-4 space-y-3 shadow-2xl z-50"
            style={{ top: dialogPos.top, left: dialogPos.left }}
          >
            <div className="flex items-center justify-between border-b border-gray-600 pb-2">
              <h3 className="text-white text-sm font-bold flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-[#2dd4bf]" />
                Buscar Análisis
              </h3>
              <button
                onClick={() => setShowSearchDialog(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-gray-300 text-xs font-medium">ID del Paciente</label>
              <input
                type="text"
                value={searchPatientId}
                onChange={(e) => setSearchPatientId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Ej: 12345"
                className="w-full bg-black border border-gray-600 rounded px-2 py-1 text-white text-sm placeholder-gray-500 focus:border-[#ffcf26] focus:outline-none focus:ring-1 focus:ring-[#ffcf26]"
                autoFocus
              />
            </div>

            {searchError && (
              <div className="bg-red-500/20 border border-red-500/50 rounded px-2 py-1">
                <p className="text-red-400 text-xs">{searchError}</p>
              </div>
            )}

            <Button
              onClick={handleSearch}
              disabled={isSearching || !searchPatientId.trim()}
              className="w-full bg-[#2dd4bf] hover:bg-[#14b8a6] text-gray-900 font-semibold py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSearching ? (
                <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Buscando...</>
              ) : (
                <>Buscar y Cargar</>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
