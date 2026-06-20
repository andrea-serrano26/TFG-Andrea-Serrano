import type { IImageCalibration } from '../types/IImageCalibration';
declare const metadataProvider: {
    add: (imageId: string, payload: IImageCalibration) => void;
    get: (type: string, imageId: string) => IImageCalibration;
};
export default metadataProvider;
