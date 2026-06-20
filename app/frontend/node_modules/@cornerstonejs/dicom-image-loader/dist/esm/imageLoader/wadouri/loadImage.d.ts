import type { DataSet } from 'dicom-parser';
import type { Types } from '@cornerstonejs/core';
import type { LoadRequestFunction, DICOMLoaderIImage, DICOMLoaderImageOptions } from '../../types';
declare function loadImageFromPromise(dataSetPromise: Promise<DataSet>, imageId: string, frame: number, sharedCacheKey: string, options: DICOMLoaderImageOptions, callbacks?: {
    imageDoneCallback: (image: DICOMLoaderIImage) => void;
}): Types.IImageLoadObject;
declare function getLoaderForScheme(scheme: string): LoadRequestFunction;
declare function loadImage(imageId: string, options?: DICOMLoaderImageOptions): Types.IImageLoadObject;
export { loadImageFromPromise, getLoaderForScheme, loadImage };
