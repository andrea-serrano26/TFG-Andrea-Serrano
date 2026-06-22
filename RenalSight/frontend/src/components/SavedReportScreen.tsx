import { Home } from 'lucide-react';
import { Button } from './ui/button';
import { PatientInfo } from './PatientInfo';

interface SavedReportScreenProps {
  reportHtml: string;
  patientData: {
    id: string;
    nombre: string;
    sexo: string;
    fechaAdquisicion: string;
  };
  onBackToLoad: () => void;
}

export function SavedReportScreen({
  reportHtml,
  patientData,
  onBackToLoad,
}: SavedReportScreenProps) {
  return (
    <div className="h-screen w-full bg-gray-900 flex flex-col overflow-hidden">
      
      {/* Cabecera */}
      <div className="bg-gray-800 border-b border-gray-700 p-3 flex-shrink-0 flex items-center justify-between">
        <PatientInfo data={patientData} />
        <Button
          onClick={onBackToLoad}
          className="bg-transparent hover:bg-gray-700/50 text-gray-400 border border-gray-600 h-8 text-xs px-4"
        >
          <Home className="mr-1.5 w-3 h-3" />
          Volver a Inicio
        </Button>
      </div>

      {/* Iframe con el HTML del informe */}
      <div className="flex-1 overflow-hidden">
        <iframe
          srcDoc={reportHtml}
          title="Informe Guardado"
          className="w-full h-full border-0"
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  );
}
