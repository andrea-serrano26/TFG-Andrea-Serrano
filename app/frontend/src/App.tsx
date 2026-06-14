import { useState } from 'react';
import { LoadScreen }         from './components/LoadScreen';
import { ViewerScreen }       from './components/ViewerScreen';
import { EditorScreen }       from './components/EditorScreen';
import { RiskAnalysisScreen } from './components/RiskAnalysisScreen';

type Screen = 'load' | 'viewer' | 'editor' | 'analysis';
type AnalysisSource = 'viewer' | 'editor' | 'saved';

export default function App() {
  const [currentScreen,  setCurrentScreen]  = useState<Screen>('load');
  const [patientData,    setPatientData]    = useState<any>(null);
  const [sessionId,      setSessionId]      = useState<string | null>(null);
  const [analysisSource, setAnalysisSource] = useState<AnalysisSource>('viewer');
  /** Resultados del análisis guardados (solo cuando source='saved') */
  const [savedAnalysis,  setSavedAnalysis]  = useState<any>(undefined);

  const handleLoadDicom = (data: any, session: string) => {
    setPatientData(data);
    setSessionId(session);
    setSavedAnalysis(undefined);  
    setCurrentScreen('viewer');
  };

  const handleLoadSavedAnalysis = async (patientId: string) => {
    try {
      const res  = await fetch(`http://localhost:8000/api/load-analysis-full/${patientId}`);
      const data = await res.json();

      if (data.success) {
        setPatientData(data.patient_data);
        setSessionId(data.session_id);
        // Usar los resultados guardados; si no existen (registro antiguo) -> undefined -> recalcula
        setSavedAnalysis(data.analysis_result ?? undefined);
        setAnalysisSource('saved');
        setCurrentScreen('analysis');
      } else {
        alert('Error: ' + (data.error || 'Análisis no encontrado'));
      }
    } catch (err) {
      console.error('Error cargando análisis:', err);
      alert('Error de conexión con el servidor');
    }
  };

  const handleBackToLoad = () => {
    setCurrentScreen('load');
    setSessionId(null);
    setPatientData(null);
    setSavedAnalysis(undefined);
  };

  return (
      <div className="h-screen bg-gray-900 overflow-hidden text-white">
  
        {currentScreen === 'load' && (
          <LoadScreen
            onLoadDicom={handleLoadDicom}
            onLoadSavedAnalysis={handleLoadSavedAnalysis}
          />
        )}
  
        {currentScreen === 'viewer' && patientData && sessionId && (
          <ViewerScreen
            sessionId={sessionId}
            patientData={patientData}
            onEditMask={() => setCurrentScreen('editor')}
            onContinue={(info: { sessionId: string; source: AnalysisSource }) => {
              setAnalysisSource(info.source);
              setCurrentScreen('analysis');
            }}
            onBackToLoad={handleBackToLoad}
          />
        )}
  
        {currentScreen === 'editor' && patientData && sessionId && (
          <EditorScreen
            sessionId={sessionId}
            patientData={patientData}
            onSaveMask={() => {
              setAnalysisSource('editor');
              setCurrentScreen('analysis');
            }}
          />
        )}
  
        {currentScreen === 'analysis' && patientData && sessionId && (
          <RiskAnalysisScreen
            sessionId={sessionId}
            patientData={patientData}
            source={analysisSource}
            savedAnalysis={savedAnalysis}
            onBackToLoad={handleBackToLoad}
            onGoToEditor={() => setCurrentScreen('editor')}
          />
        )}
  
      </div>
    );
  }