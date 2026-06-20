import svgNodeCache, { resetSvgNodeCache } from './svgNodeCache';
const defaultState = {
    isInteractingWithTool: false,
    isMultiPartToolActive: false,
    tools: {},
    toolGroups: [],
    synchronizers: [],
    svgNodeCache: svgNodeCache,
    enabledElements: [],
    handleRadius: 6,
};
let state = {
    isInteractingWithTool: false,
    isMultiPartToolActive: false,
    tools: {},
    toolGroups: [],
    synchronizers: [],
    svgNodeCache: svgNodeCache,
    enabledElements: [],
    handleRadius: 6,
};
function resetCornerstoneToolsState() {
    resetSvgNodeCache();
    state = {
        ...structuredClone({
            ...defaultState,
            svgNodeCache: {},
        }),
        svgNodeCache: {
            ...defaultState.svgNodeCache,
        },
    };
}
export { resetCornerstoneToolsState, state, state as default };
