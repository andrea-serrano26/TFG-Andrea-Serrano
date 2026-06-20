import { Enums } from '@cornerstonejs/core';
import createImage from '../createImage';
import { xhrRequest } from '../internal/index';
import dataSetCacheManager from './dataSetCacheManager';
import getPixelData from './getPixelData';
import loadFileRequest from './loadFileRequest';
import parseImageId from './parseImageId';
const { ImageQualityStatus } = Enums;
function addDecache(imageLoadObject, imageId) {
    imageLoadObject.decache = function () {
        const parsedImageId = parseImageId(imageId);
        dataSetCacheManager.unload(parsedImageId.url);
    };
}
function loadImageFromPromise(dataSetPromise, imageId, frame = 0, sharedCacheKey, options, callbacks) {
    const start = new Date().getTime();
    const imageLoadObject = {
        cancelFn: undefined,
        promise: undefined,
    };
    imageLoadObject.promise = new Promise((resolve, reject) => {
        dataSetPromise.then((dataSet) => {
            const pixelData = getPixelData(dataSet, frame);
            const transferSyntax = dataSet.string('x00020010');
            const loadEnd = new Date().getTime();
            const imagePromise = createImage(imageId, pixelData, transferSyntax, options);
            addDecache(imageLoadObject, imageId);
            imagePromise.then((image) => {
                image = image;
                image.data = dataSet;
                image.sharedCacheKey = sharedCacheKey;
                const end = new Date().getTime();
                image.loadTimeInMS = loadEnd - start;
                image.totalTimeInMS = end - start;
                image.imageQualityStatus = ImageQualityStatus.FULL_RESOLUTION;
                if (callbacks !== undefined &&
                    callbacks.imageDoneCallback !== undefined) {
                    callbacks.imageDoneCallback(image);
                }
                resolve(image);
            }, function (error) {
                reject({
                    error,
                    dataSet,
                });
            });
        }, function (error) {
            reject({
                error,
            });
        });
    });
    return imageLoadObject;
}
function loadImageFromDataSet(dataSet, imageId, frame = 0, sharedCacheKey, options) {
    const start = new Date().getTime();
    const promise = new Promise((resolve, reject) => {
        const loadEnd = new Date().getTime();
        let imagePromise;
        try {
            const pixelData = getPixelData(dataSet, frame);
            const transferSyntax = dataSet.string('x00020010');
            imagePromise = createImage(imageId, pixelData, transferSyntax, options);
        }
        catch (error) {
            reject({
                error,
                dataSet,
            });
            return;
        }
        imagePromise.then((image) => {
            image = image;
            image.data = dataSet;
            const end = new Date().getTime();
            image.loadTimeInMS = loadEnd - start;
            image.totalTimeInMS = end - start;
            image.imageQualityStatus = ImageQualityStatus.FULL_RESOLUTION;
            resolve(image);
        }, reject);
    });
    return {
        promise: promise,
        cancelFn: undefined,
    };
}
function getLoaderForScheme(scheme) {
    if (scheme === 'dicomweb' || scheme === 'wadouri') {
        return xhrRequest;
    }
    else if (scheme === 'dicomfile') {
        return loadFileRequest;
    }
}
function loadImage(imageId, options = {}) {
    const parsedImageId = parseImageId(imageId);
    options = Object.assign({}, options);
    delete options.loader;
    const schemeLoader = getLoaderForScheme(parsedImageId.scheme);
    if (dataSetCacheManager.isLoaded(parsedImageId.url)) {
        const dataSet = dataSetCacheManager.get(parsedImageId.url, schemeLoader, imageId);
        return loadImageFromDataSet(dataSet, imageId, parsedImageId.pixelDataFrame, parsedImageId.url, options);
    }
    const dataSetPromise = dataSetCacheManager.load(parsedImageId.url, schemeLoader, imageId);
    return loadImageFromPromise(dataSetPromise, imageId, parsedImageId.pixelDataFrame, parsedImageId.url, options);
}
export { loadImageFromPromise, getLoaderForScheme, loadImage };
