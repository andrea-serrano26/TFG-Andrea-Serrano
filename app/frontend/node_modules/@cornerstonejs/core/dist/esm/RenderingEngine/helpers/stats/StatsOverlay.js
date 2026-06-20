import { StatsPanel } from './StatsPanel';
import { PanelType } from './enums';
import { STATS_CONFIG, PANEL_CONFIGS, CONVERSION } from './constants';
export class StatsOverlay {
    static { this.instance = null; }
    constructor() {
        this.dom = null;
        this.currentMode = 0;
        this.startTime = 0;
        this.lastUpdateTime = 0;
        this.frameCount = 0;
        this.panels = new Map();
        this.animationFrameId = null;
        this.isSetup = false;
    }
    static getInstance() {
        if (!StatsOverlay.instance) {
            StatsOverlay.instance = new StatsOverlay();
        }
        return StatsOverlay.instance;
    }
    setup() {
        if (this.isSetup) {
            return;
        }
        try {
            this.dom = this.createOverlayElement();
            this.startTime = performance.now();
            this.lastUpdateTime = this.startTime;
            this.initializePanels();
            this.showPanel(PanelType.FPS);
            this.applyOverlayStyles();
            document.body.appendChild(this.dom);
            this.startLoop();
            this.isSetup = true;
        }
        catch (error) {
            console.warn('Failed to setup stats overlay:', error);
        }
    }
    cleanup() {
        this.stopLoop();
        if (this.dom && this.dom.parentNode) {
            this.dom.parentNode.removeChild(this.dom);
        }
        this.dom = null;
        this.panels.clear();
        this.isSetup = false;
    }
    showPanel(panelType) {
        const children = Array.from(this.dom.children);
        children.forEach((child, index) => {
            child.style.display = index === panelType ? 'block' : 'none';
        });
        this.currentMode = panelType;
    }
    update() {
        this.startTime = this.updateStats();
    }
    createOverlayElement() {
        const element = document.createElement('div');
        element.addEventListener('click', this.handleClick.bind(this), false);
        return element;
    }
    applyOverlayStyles() {
        Object.assign(this.dom.style, STATS_CONFIG.OVERLAY_STYLES);
    }
    handleClick(event) {
        event.preventDefault();
        const panelCount = this.dom.children.length;
        this.showPanel((this.currentMode + 1) % panelCount);
    }
    initializePanels() {
        const fpsPanel = new StatsPanel(PANEL_CONFIGS[PanelType.FPS].name, PANEL_CONFIGS[PanelType.FPS].foregroundColor, PANEL_CONFIGS[PanelType.FPS].backgroundColor);
        this.addPanel(PanelType.FPS, fpsPanel);
        const msPanel = new StatsPanel(PANEL_CONFIGS[PanelType.MS].name, PANEL_CONFIGS[PanelType.MS].foregroundColor, PANEL_CONFIGS[PanelType.MS].backgroundColor);
        this.addPanel(PanelType.MS, msPanel);
        if (this.isMemoryAvailable()) {
            const memPanel = new StatsPanel(PANEL_CONFIGS[PanelType.MEMORY].name, PANEL_CONFIGS[PanelType.MEMORY].foregroundColor, PANEL_CONFIGS[PanelType.MEMORY].backgroundColor);
            this.addPanel(PanelType.MEMORY, memPanel);
        }
    }
    isMemoryAvailable() {
        const perf = performance;
        return perf.memory !== undefined;
    }
    addPanel(type, panel) {
        this.dom.appendChild(panel.dom);
        this.panels.set(type, panel);
    }
    startLoop() {
        const loop = () => {
            this.update();
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }
    stopLoop() {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }
    updateStats() {
        this.frameCount++;
        const currentTime = performance.now();
        const deltaTime = currentTime - this.startTime;
        const msPanel = this.panels.get(PanelType.MS);
        if (msPanel) {
            msPanel.update(deltaTime, STATS_CONFIG.MAX_MS_VALUE);
        }
        if (currentTime >= this.lastUpdateTime + STATS_CONFIG.UPDATE_INTERVAL) {
            const fps = (this.frameCount * CONVERSION.MS_PER_SECOND) /
                (currentTime - this.lastUpdateTime);
            const fpsPanel = this.panels.get(PanelType.FPS);
            if (fpsPanel) {
                fpsPanel.update(fps, STATS_CONFIG.MAX_FPS_VALUE);
            }
            this.lastUpdateTime = currentTime;
            this.frameCount = 0;
            this.updateMemoryPanel();
        }
        return currentTime;
    }
    updateMemoryPanel() {
        const memPanel = this.panels.get(PanelType.MEMORY);
        if (!memPanel) {
            return;
        }
        const perf = performance;
        if (perf.memory) {
            const memoryMB = perf.memory.usedJSHeapSize / CONVERSION.BYTES_TO_MB;
            const maxMemoryMB = perf.memory.jsHeapSizeLimit / CONVERSION.BYTES_TO_MB;
            memPanel.update(memoryMB, maxMemoryMB);
        }
    }
}
