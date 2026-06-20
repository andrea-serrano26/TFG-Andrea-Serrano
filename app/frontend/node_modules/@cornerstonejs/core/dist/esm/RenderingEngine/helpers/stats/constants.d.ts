declare const PANEL_CONFIG: {
    readonly WIDTH: 160;
    readonly HEIGHT: 96;
    readonly TEXT_PADDING: 3;
    readonly TEXT_Y_OFFSET: 2;
    readonly GRAPH_Y_OFFSET: 15;
    readonly GRAPH_WIDTH: 150;
    readonly GRAPH_HEIGHT: 70;
    readonly FONT_SIZE: 9;
    readonly FONT_FAMILY: "Helvetica,Arial,sans-serif";
    readonly GRAPH_ALPHA: 0.9;
};
declare const STATS_CONFIG: {
    readonly UPDATE_INTERVAL: 1000;
    readonly MAX_MS_VALUE: 200;
    readonly MAX_FPS_VALUE: 300;
    readonly OVERLAY_STYLES: {
        readonly position: "fixed";
        readonly top: "0px";
        readonly right: "0px";
        readonly left: "auto";
        readonly zIndex: "9999";
        readonly cursor: "pointer";
        readonly opacity: "0.9";
    };
};
declare const CONVERSION: {
    readonly BYTES_TO_MB: 1048576;
    readonly MS_PER_SECOND: 1000;
};
declare const PANEL_CONFIGS: readonly [{
    readonly name: "FPS";
    readonly foregroundColor: "#0ff";
    readonly backgroundColor: "#002";
}, {
    readonly name: "MS";
    readonly foregroundColor: "#0f0";
    readonly backgroundColor: "#020";
}, {
    readonly name: "MB";
    readonly foregroundColor: "#f08";
    readonly backgroundColor: "#201";
}];
export { PANEL_CONFIG, STATS_CONFIG, CONVERSION, PANEL_CONFIGS };
