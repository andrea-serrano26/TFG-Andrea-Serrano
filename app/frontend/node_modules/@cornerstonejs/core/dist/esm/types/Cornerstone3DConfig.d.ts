import type { RenderingEngineModeType } from '../types';
interface Cornerstone3DConfig {
    gpuTier?: {
        tier?: number;
    };
    isMobile?: boolean;
    rendering?: {
        preferSizeOverAccuracy?: boolean;
        useCPURendering?: boolean;
        useLegacyCameraFOV?: boolean;
        strictZSpacingForVolumeViewport?: boolean;
        renderingEngineMode?: RenderingEngineModeType;
        webGlContextCount?: number;
        volumeRendering?: {
            sampleDistanceMultiplier?: number;
        };
    };
    debug: {
        statsOverlay?: boolean;
    };
    peerImport?: (moduleId: string) => Promise<any>;
}
export type { Cornerstone3DConfig as default };
