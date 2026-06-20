import { loadAndCacheImage } from '../../loaders/imageLoader';
import * as metaData from '../../metaData';
import * as windowLevel from '../../utilities/windowLevel';
import { RequestType } from '../../enums';
import cache from '../../cache/cache';
const PRIORITY = 0;
const REQUEST_TYPE = RequestType.Prefetch;
async function setDefaultVolumeVOI(volumeActor, imageVolume) {
    let voi = getVOIFromMetadata(imageVolume);
    if (!voi && imageVolume.imageIds.length) {
        voi = await getVOIFromMiddleSliceMinMax(imageVolume);
        voi = handlePreScaledVolume(imageVolume, voi);
    }
    if ((voi.lower === 0 && voi.upper === 0) ||
        voi.lower === undefined ||
        voi.upper === undefined) {
        return;
    }
    volumeActor
        .getProperty()
        .getRGBTransferFunction(0)
        .setMappingRange(voi.lower, voi.upper);
}
function handlePreScaledVolume(imageVolume, voi) {
    const imageIds = imageVolume.imageIds;
    const imageIdIndex = Math.floor(imageIds.length / 2);
    const imageId = imageIds[imageIdIndex];
    const generalSeriesModule = metaData.get('generalSeriesModule', imageId) || {};
    if (_isCurrentImagePTPrescaled(generalSeriesModule.modality, imageVolume)) {
        return {
            lower: 0,
            upper: 5,
        };
    }
    return voi;
}
function getVOIFromMetadata(imageVolume) {
    const { imageIds, metadata } = imageVolume;
    let voi;
    if (imageIds?.length) {
        const imageIdIndex = Math.floor(imageIds.length / 2);
        const imageId = imageIds[imageIdIndex];
        const voiLutModule = metaData.get('voiLutModule', imageId);
        if (voiLutModule && voiLutModule.windowWidth && voiLutModule.windowCenter) {
            if (voiLutModule?.voiLUTFunction) {
                voi = {};
                voi.voiLUTFunction = voiLutModule?.voiLUTFunction;
            }
            const { windowWidth, windowCenter } = voiLutModule;
            const width = Array.isArray(windowWidth) ? windowWidth[0] : windowWidth;
            const center = Array.isArray(windowCenter)
                ? windowCenter[0]
                : windowCenter;
            if (width !== 0) {
                voi = { windowWidth: width, windowCenter: center };
            }
        }
    }
    else {
        voi = metadata.voiLut[0];
    }
    if (voi && (voi.windowWidth !== 0 || voi.windowCenter !== 0)) {
        const { lower, upper } = windowLevel.toLowHighRange(Number(voi.windowWidth), Number(voi.windowCenter), voi.voiLUTFunction);
        if (isNaN(lower) || isNaN(upper)) {
            return;
        }
        return { lower, upper };
    }
    return undefined;
}
async function getVOIFromMiddleSliceMinMax(imageVolume) {
    const { imageIds } = imageVolume;
    const imageIdIndex = Math.floor(imageIds.length / 2);
    const imageId = imageVolume.imageIds[imageIdIndex];
    const generalSeriesModule = metaData.get('generalSeriesModule', imageId) || {};
    const { modality } = generalSeriesModule;
    const modalityLutModule = metaData.get('modalityLutModule', imageId) || {};
    const scalingParameters = {
        rescaleSlope: modalityLutModule.rescaleSlope,
        rescaleIntercept: modalityLutModule.rescaleIntercept,
        modality,
    };
    let scalingParametersToUse;
    if (modality === 'PT') {
        const suvFactor = metaData.get('scalingModule', imageId);
        if (suvFactor) {
            scalingParametersToUse = {
                ...scalingParameters,
                suvbw: suvFactor.suvbw,
            };
        }
    }
    const options = {
        priority: PRIORITY,
        requestType: REQUEST_TYPE,
        preScale: {
            scalingParameters: scalingParametersToUse,
        },
    };
    let image = cache.getImage(imageId);
    if (!imageVolume.referencedImageIds?.length) {
        image = await loadAndCacheImage(imageId, { ...options, ignoreCache: true });
    }
    let { min, max } = image.voxelManager.getMinMax();
    if (min?.length > 1) {
        min = Math.min(...min);
        max = Math.max(...max);
    }
    return {
        lower: min,
        upper: max,
    };
}
function _isCurrentImagePTPrescaled(modality, imageVolume) {
    if (modality !== 'PT' || !imageVolume.isPreScaled) {
        return false;
    }
    if (!imageVolume.scaling?.PT.suvbw) {
        return false;
    }
    return true;
}
export default setDefaultVolumeVOI;
