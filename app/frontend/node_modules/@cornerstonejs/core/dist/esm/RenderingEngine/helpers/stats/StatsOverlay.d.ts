import type { StatsInstance } from './types';
export declare class StatsOverlay implements StatsInstance {
    private static instance;
    dom: HTMLDivElement | null;
    private currentMode;
    private startTime;
    private lastUpdateTime;
    private frameCount;
    private panels;
    private animationFrameId;
    private isSetup;
    private constructor();
    static getInstance(): StatsOverlay;
    setup(): void;
    cleanup(): void;
    showPanel(panelType: number): void;
    update(): void;
    private createOverlayElement;
    private applyOverlayStyles;
    private handleClick;
    private initializePanels;
    private isMemoryAvailable;
    private addPanel;
    private startLoop;
    private stopLoop;
    private updateStats;
    private updateMemoryPanel;
}
