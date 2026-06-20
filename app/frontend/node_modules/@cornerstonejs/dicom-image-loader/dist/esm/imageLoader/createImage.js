import getMinMax from '../shared/getMinMax';
import { canRenderFloatTextures, Enums, metaData, utilities, } from '@cornerstonejs/core';
import convertColorSpace from './convertColorSpace';
import isColorConversionRequired from './isColorConversionRequired';
import decodeImageFrame from './decodeImageFrame';
import getImageFrame from './getImageFrame';
import getScalingParameters from './getScalingParameters';
import { getOptions } from './internal/options';
import isColorImageFn from '../shared/isColorImage';
import removeAFromRGBA from './removeAFromRGBA';
import isModalityLUTForDisplay from './isModalityLutForDisplay';
import setPixelDataType from './setPixelDataType';
let lastImageIdDrawn = '';
function createImage(imageId, pixelData, transferSyntax, options = {}) {
    const useRGBA = options.useRGBA;
    options.preScale = {
        enabled: options.preScale && options.preScale.enabled !== undefined
            ? options.preScale.enabled
            : true,
    };
    if (!pixelData?.length) {
        return Promise.reject(new Error('The pixel data is missing'));
    }
    const { MetadataModules } = Enums;
    const canvas = document.createElement('canvas');
    const imageFrame = getImageFrame(imageId);
    imageFrame.decodeLevel = options.decodeLevel;
    options.allowFloatRendering = canRenderFloatTextures();
    if (options.preScale.enabled) {
        const scalingParameters = getScalingParameters(metaData, imageId);
        if (scalingParameters) {
            options.preScale = {
                ...options.preScale,
                scalingParameters: scalingParameters,
            };
        }
    }
    const { decodeConfig } = getOptions();
    Object.keys(imageFrame).forEach((key) => {
        if (typeof imageFrame[key] === 'function' ||
            imageFrame[key] instanceof Promise) {
            delete imageFrame[key];
        }
    });
    const decodePromise = decodeImageFrame(imageFrame, transferSyntax, pixelData, canvas, options, decodeConfig);
    const isColorImage = isColorImageFn(imageFrame.photometricInterpretation);
    return new Promise((resolve, reject) => {
        decodePromise.then(function (imageFrame) {
            let alreadyTyped = false;
            if (options.targetBuffer &&
                options.targetBuffer.type &&
                !isColorImage) {
                const { arrayBuffer, type, offset: rawOffset = 0, length: rawLength, } = options.targetBuffer;
                const imageFrameLength = imageFrame.pixelDataLength;
                const offset = rawOffset;
                const length = rawLength !== null && rawLength !== undefined
                    ? rawLength
                    : imageFrameLength - offset;
                const typedArrayConstructors = {
                    Uint8Array,
                    Uint16Array,
                    Int16Array,
                    Float32Array,
                    Uint32Array,
                };
                if (length !== imageFrame.pixelDataLength) {
                    throw new Error(`target array for image does not have the same length (${length}) as the decoded image length (${imageFrame.pixelDataLength}).`);
                }
                const TypedArrayConstructor = typedArrayConstructors[type];
                const typedArray = arrayBuffer
                    ? new TypedArrayConstructor(arrayBuffer, offset, length)
                    : new TypedArrayConstructor(imageFrame.pixelData);
                if (length !== imageFrame.pixelDataLength) {
                    throw new Error('target array for image does not have the same length as the decoded image length.');
                }
                imageFrame.pixelData = typedArray;
                alreadyTyped = true;
            }
            if (!alreadyTyped) {
                setPixelDataType(imageFrame);
            }
            const imagePlaneModule = metaData.get(MetadataModules.IMAGE_PLANE, imageId) || {};
            const voiLutModule = metaData.get(MetadataModules.VOI_LUT, imageId) || {};
            const modalityLutModule = metaData.get(MetadataModules.MODALITY_LUT, imageId) || {};
            const sopCommonModule = metaData.get(MetadataModules.SOP_COMMON, imageId) || {};
            const calibrationModule = metaData.get(MetadataModules.CALIBRATION, imageId) || {};
            const { rows, columns } = imageFrame;
            if (isColorImage) {
                if (isColorConversionRequired(imageFrame)) {
                    canvas.height = imageFrame.rows;
                    canvas.width = imageFrame.columns;
                    const context = canvas.getContext('2d');
                    let imageData = context.createImageData(imageFrame.columns, imageFrame.rows);
                    if (!useRGBA) {
                        imageData = {
                            ...imageData,
                            data: new Uint8ClampedArray(3 * imageFrame.columns * imageFrame.rows),
                        };
                    }
                    convertColorSpace(imageFrame, imageData.data, useRGBA);
                    imageFrame.imageData = imageData;
                    imageFrame.pixelData = imageData.data;
                    imageFrame.pixelDataLength = imageData.data.length;
                }
                else if (!useRGBA &&
                    imageFrame.pixelDataLength === 4 * rows * columns) {
                    const colorBuffer = new Uint8Array((imageFrame.pixelData.length / 4) * 3);
                    imageFrame.pixelData = removeAFromRGBA(imageFrame.pixelData, colorBuffer);
                    imageFrame.pixelDataLength = imageFrame.pixelData.length;
                }
                const minMax = getMinMax(imageFrame.pixelData);
                imageFrame.smallestPixelValue = minMax.min;
                imageFrame.largestPixelValue = minMax.max;
            }
            let numberOfComponents = imageFrame.samplesPerPixel;
            if (imageFrame.photometricInterpretation === 'PALETTE COLOR') {
                numberOfComponents = useRGBA ? 4 : 3;
            }
            const voxelManager = utilities.VoxelManager.createImageVoxelManager({
                scalarData: imageFrame.pixelData,
                width: imageFrame.columns,
                height: imageFrame.rows,
                numberOfComponents: numberOfComponents,
            });
            const image = {
                imageId,
                dataType: imageFrame.pixelData.constructor
                    .name,
                color: isColorImage,
                calibration: calibrationModule,
                columnPixelSpacing: imagePlaneModule.columnPixelSpacing,
                columns: imageFrame.columns,
                height: imageFrame.rows,
                preScale: imageFrame.preScale,
                intercept: modalityLutModule.rescaleIntercept
                    ? modalityLutModule.rescaleIntercept
                    : 0,
                slope: modalityLutModule.rescaleSlope
                    ? modalityLutModule.rescaleSlope
                    : 1,
                invert: imageFrame.photometricInterpretation === 'MONOCHROME1',
                minPixelValue: imageFrame.smallestPixelValue,
                maxPixelValue: imageFrame.largestPixelValue,
                rowPixelSpacing: imagePlaneModule.rowPixelSpacing,
                rows: imageFrame.rows,
                sizeInBytes: imageFrame.pixelData.byteLength,
                width: imageFrame.columns,
                windowCenter: voiLutModule.windowCenter
                    ? voiLutModule.windowCenter[0]
                    : undefined,
                windowWidth: voiLutModule.windowWidth
                    ? voiLutModule.windowWidth[0]
                    : undefined,
                voiLUTFunction: voiLutModule.voiLUTFunction
                    ? voiLutModule.voiLUTFunction
                    : undefined,
                decodeTimeInMS: imageFrame.decodeTimeInMS,
                floatPixelData: undefined,
                imageFrame,
                voxelManager,
                rgba: isColorImage && useRGBA,
                getPixelData: () => imageFrame.pixelData,
                getCanvas: undefined,
                numberOfComponents: numberOfComponents,
            };
            if (image.color) {
                image.getCanvas = function () {
                    if (lastImageIdDrawn === imageId) {
                        return canvas;
                    }
                    const width = image.columns;
                    const height = image.rows;
                    canvas.height = height;
                    canvas.width = width;
                    const ctx = canvas.getContext('2d');
                    const imageData = ctx.createImageData(width, height);
                    const arr = imageFrame.pixelData;
                    if (arr.length === width * height * 4) {
                        for (let i = 0; i < arr.length; i++) {
                            imageData.data[i] = arr[i];
                        }
                    }
                    else if (arr.length === width * height * 3) {
                        let j = 0;
                        for (let i = 0; i < arr.length; i += 3) {
                            imageData.data[j++] = arr[i];
                            imageData.data[j++] = arr[i + 1];
                            imageData.data[j++] = arr[i + 2];
                            imageData.data[j++] = 255;
                        }
                    }
                    imageFrame.pixelData = imageData.data;
                    imageFrame.pixelDataLength = imageData.data.length;
                    imageFrame.imageData = imageData;
                    ctx.putImageData(imageFrame.imageData, 0, 0);
                    lastImageIdDrawn = imageId;
                    return canvas;
                };
            }
            if (modalityLutModule.modalityLUTSequence &&
                modalityLutModule.modalityLUTSequence.length > 0 &&
                isModalityLUTForDisplay(sopCommonModule.sopClassUID)) {
                image.modalityLUT = modalityLutModule.modalityLUTSequence[0];
            }
            if (voiLutModule.voiLUTSequence &&
                voiLutModule.voiLUTSequence.length > 0) {
                image.voiLUT = voiLutModule.voiLUTSequence[0];
            }
            if (image.color) {
                image.windowWidth = 256;
                image.windowCenter = 128;
            }
            if (image.windowCenter === undefined ||
                image.windowWidth === undefined) {
                const windowLevel = utilities.windowLevel.toWindowLevel(image.imageFrame.smallestPixelValue, image.imageFrame.largestPixelValue);
                image.windowWidth = windowLevel.windowWidth;
                image.windowCenter = windowLevel.windowCenter;
            }
            resolve(image);
        }, reject);
    });
}
export default createImage;
