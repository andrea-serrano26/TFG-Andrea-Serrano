import { User, Calendar, Hash } from 'lucide-react';

interface PatientInfoProps {
  data: {
    id: string;
    nombre: string;
    sexo: string;
    fechaAdquisicion: string;
  };
}

export function PatientInfo({ data }: PatientInfoProps) {
  // Formatear fecha correctamente a DD/MM/YYYY, manejando tanto formato DICOM como ISO
  const formatDate = (dateStr: string) => {
    try {
      // Formato DICOM: YYYYMMDD
      if (dateStr.length === 8 && !dateStr.includes('-')) {
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        const date = new Date(`${year}-${month}-${day}`);
        return date.toLocaleDateString('es-ES', { 
          day: '2-digit', 
          month: '2-digit', 
          year: 'numeric' 
        });
      }
      // Ya está en formato ISO o similar
      const date = new Date(dateStr);
      return date.toLocaleDateString('es-ES', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric' 
      });
    } catch {
      return dateStr; // Si falla, devolver original
    }
  };

  return (
    <div className="flex items-center gap-6 text-xs">
      <div className="flex items-center gap-2">
        <Hash className="w-3 h-3 text-[#ffcf26]" />
        <span className="text-gray-400">ID:</span>
        <span className="text-white">{data.id}</span>
      </div>
      
      <div className="flex items-center gap-2">
        <User className="w-3 h-3 text-[#ffcf26]" />
        <span className="text-gray-400">Paciente:</span>
        <span className="text-white">{data.nombre}</span>
      </div>
      
      <div className="flex items-center gap-2">
        <span className="text-gray-400">Sexo:</span>
        <span className="text-white">{data.sexo}</span>
      </div>
      
      <div className="flex items-center gap-2">
        <Calendar className="w-3 h-3 text-[#ffcf26]" />
        <span className="text-gray-400">Fecha:</span>
        <span className="text-white">{formatDate(data.fechaAdquisicion)}</span>
      </div>
    </div>
  );
}
