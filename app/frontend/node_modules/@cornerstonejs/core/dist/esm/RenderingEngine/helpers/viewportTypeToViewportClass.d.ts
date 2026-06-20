import type { ViewportInput, IViewport } from '../../types/IViewport';
interface ViewportConstructor {
    new (viewportInput: ViewportInput): IViewport;
}
declare const viewportTypeToViewportClass: {
    [key: string]: ViewportConstructor;
};
export default viewportTypeToViewportClass;
