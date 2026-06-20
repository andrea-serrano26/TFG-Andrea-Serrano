import * as metaData from '../metaData';
import { MetadataModules, VOILUTFunctionType } from '../enums';
export function getValidVOILUTFunction(voiLUTFunction) {
    if (!Object.values(VOILUTFunctionType).includes(voiLUTFunction)) {
        return VOILUTFunctionType.LINEAR;
    }
    return voiLUTFunction;
}
export function getImagePlaneModule(imageId) {
    const imagePlaneModule = metaData.get(MetadataModules.IMAGE_PLANE, imageId);
    const newImagePlaneModule = {
        ...imagePlaneModule,
    };
    if (!newImagePlaneModule.columnPixelSpacing) {
        newImagePlaneModule.columnPixelSpacing = 1;
    }
    if (!newImagePlaneModule.rowPixelSpacing) {
        newImagePlaneModule.rowPixelSpacing = 1;
    }
    if (!newImagePlaneModule.columnCosines) {
        newImagePlaneModule.columnCosines = [0, 1, 0];
    }
    if (!newImagePlaneModule.rowCosines) {
        newImagePlaneModule.rowCosines = [1, 0, 0];
    }
    if (!newImagePlaneModule.imagePositionPatient) {
        newImagePlaneModule.imagePositionPatient = [0, 0, 0];
    }
    if (!newImagePlaneModule.imageOrientationPatient) {
        newImagePlaneModule.imageOrientationPatient = new Float32Array([
            1, 0, 0, 0, 1, 0,
        ]);
    }
    return newImagePlaneModule;
}
export function calibrateImagePlaneModule(imageId, imagePlaneModule, currentCalibration) {
    const calibration = metaData.get('calibratedPixelSpacing', imageId);
    const isUpdated = currentCalibration !== calibration;
    const { scale } = calibration || {};
    const hasPixelSpacing = scale > 0 || imagePlaneModule.rowPixelSpacing > 0;
    imagePlaneModule.calibration = calibration;
    if (!isUpdated) {
        return { imagePlaneModule, hasPixelSpacing };
    }
    return {
        imagePlaneModule,
        hasPixelSpacing,
        calibrationEvent: {
            scale,
            calibration,
        },
    };
}
export function buildMetadata(image) {
    const imageId = image.imageId;
    const { pixelRepresentation, bitsAllocated, bitsStored, highBit, photometricInterpretation, samplesPerPixel, } = metaData.get('imagePixelModule', imageId);
    const { windowWidth, windowCenter, voiLUTFunction } = image;
    const { modality } = metaData.get('generalSeriesModule', imageId);
    const imageIdScalingFactor = metaData.get('scalingModule', imageId);
    const calibration = metaData.get(MetadataModules.CALIBRATION, imageId);
    const voiLUTFunctionEnum = getValidVOILUTFunction(voiLUTFunction);
    const imagePlaneModule = getImagePlaneModule(imageId);
    return {
        calibration,
        scalingFactor: imageIdScalingFactor,
        voiLUTFunction: voiLUTFunctionEnum,
        modality,
        imagePlaneModule,
        imagePixelModule: {
            bitsAllocated,
            bitsStored,
            samplesPerPixel,
            highBit,
            photometricInterpretation,
            pixelRepresentation,
            windowWidth: windowWidth,
            windowCenter: windowCenter,
            modality,
            voiLUTFunction: voiLUTFunctionEnum,
        },
    };
}
