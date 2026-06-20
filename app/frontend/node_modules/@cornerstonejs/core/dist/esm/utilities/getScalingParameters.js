import * as metaData from '../metaData';
export default function getScalingParameters(imageId) {
    const modalityLutModule = metaData.get('modalityLutModule', imageId) || {};
    const generalSeriesModule = metaData.get('generalSeriesModule', imageId) || {};
    const { modality } = generalSeriesModule;
    const scalingParameters = {
        rescaleSlope: modalityLutModule.rescaleSlope || 1,
        rescaleIntercept: modalityLutModule.rescaleIntercept ?? 0,
        modality,
    };
    const scalingModules = metaData.get('scalingModule', imageId) || {};
    return {
        ...scalingParameters,
        ...(modality === 'PT' && {
            suvbw: scalingModules.suvbw,
            suvbsa: scalingModules.suvbsa,
            suvlbm: scalingModules.suvlbm,
        }),
        ...(modality === 'RTDOSE' && {
            doseGridScaling: scalingModules.DoseGridScaling,
            doseSummation: scalingModules.DoseSummation,
            doseType: scalingModules.DoseType,
            doseUnit: scalingModules.DoseUnit,
        }),
    };
}
