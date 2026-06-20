import type { LabelmapSegmentationData } from '../../../types/LabelmapTypes';
import type { LabelmapRenderingConfig } from '../../../types/SegmentationStateTypes';
declare function addLabelmapToElement(element: HTMLDivElement, labelMapData: LabelmapSegmentationData, segmentationId: string, config: LabelmapRenderingConfig): Promise<void | {
    uid: string;
    actor: any;
}>;
export default addLabelmapToElement;
